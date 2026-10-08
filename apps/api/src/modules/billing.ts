import { z } from 'zod';
import type { Transaction } from 'kysely';
import {
  BillingMaintenanceReport, CheckoutRequest, CheckoutResponse, CouponValidateRequest, CouponView, EntitlementsView, PlanList, PlansQuery, PortalResponse, WebhookAck,
} from '@fp/contracts';
import { audienceAllowed, FEATURES, isFeature, isMinor, nextMonthStart, planLimits, subscriptionGrants } from '@fp/domain';
import type { AgeBand, Role, SubscriptionStatus } from '@fp/domain';
import type { DB } from '@fp/db';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import { ApiError, conflict, forbidden, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { audit, notify } from '../platform/events.js';
import { configuredDefaults, entitlementsFor, planRows, scoutSearchesUsed, shortlistSlotsUsed, toPlanDefinition, uploadUsage } from '../platform/entitlements.js';
import type { BillingEvent, PaymentProvider, ProviderSubscription } from '../platform/billing/provider.js';
import { WebhookSignatureError } from '../platform/billing/provider.js';
import { retryPendingCancellations } from '../platform/billing/cancellations.js';
import { timingSafeEqual } from 'node:crypto';

function bearerIs(header: string | undefined, secret: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

type Bilingual = { en: string; ar: string };

/** Billing endpoints refuse plainly when no provider is configured; nothing pretends to work. */
function provider(deps: Deps): PaymentProvider {
  if (!deps.billing) throw new ApiError(503, 'BILLING_NOT_CONFIGURED', 'payments are not enabled yet');
  return deps.billing;
}

const webUrl = (deps: Deps, path: string) => `${deps.config.WEB_APP_URL.replace(/\/+$/, '')}${path}`;

// ---------------------------------------------------------------- coupons

type CouponRow = Awaited<ReturnType<typeof findCoupon>>;
function findCoupon(deps: Deps, code: string) {
  return deps.db.selectFrom('coupons').selectAll().where('code', '=', code).executeTakeFirst();
}

/**
 * Checks a coupon or referral code for a plan and buyer. Every failure is COUPON_INVALID with the
 * reason, so the buyer knows why before reaching the payment page.
 */
async function validCoupon(deps: Deps, code: string, plan: { key: string }, buyerIds: string[], currency: string) {
  const c = await findCoupon(deps, code);
  const invalid = (why: string) => new ApiError(400, 'COUPON_INVALID', why);
  const now = deps.now();
  if (!c || !c.active) throw invalid('this code does not exist or is no longer active');
  if (c.valid_from && c.valid_from > now) throw invalid('this code is not valid yet');
  if (c.valid_until && c.valid_until <= now) throw invalid('this code has expired');
  if (c.plan_keys && !c.plan_keys.includes(plan.key)) throw invalid('this code does not apply to this plan');
  if (c.max_redemptions !== null && c.redeemed_count >= c.max_redemptions) throw invalid('this code has been used up');
  if (c.amount_off_minor !== null && c.currency !== currency) throw invalid('this code does not apply to this currency');
  if (c.referrer_user_id && buyerIds.includes(c.referrer_user_id)) throw invalid('you cannot use your own referral code');
  const used = await deps.db.selectFrom('coupon_redemptions').select('code').where('code', '=', c.code).where('user_id', 'in', buyerIds).executeTakeFirst();
  if (used) throw invalid('you have already used this code');
  // Codes are applied by the payment provider; one without a provider promotion code cannot be honoured at checkout.
  if (!c.provider_promotion_code_id) throw new ApiError(400, 'COUPON_NOT_AVAILABLE', 'this code cannot be used at checkout yet');
  return c;
}

const couponView = (c: NonNullable<CouponRow>) => ({
  code: c.code, kind: c.kind as 'coupon' | 'referral', percentOff: c.percent_off, amountOffMinor: c.amount_off_minor, currency: c.currency,
  duration: c.duration as 'once' | 'repeating' | 'forever', durationMonths: c.duration_months,
});

// ---------------------------------------------------------------- webhook processing

const GRANTING = new Set(['trialing', 'active', 'past_due']);

async function userExists(tx: Transaction<DB>, id: string | undefined) {
  if (!id || !z.uuid().safeParse(id).success) return false;
  return Boolean(await tx.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst());
}

async function rememberCustomer(tx: Transaction<DB>, providerName: string, userId: string, customerId: string | null) {
  if (!customerId) return;
  await tx.insertInto('billing_customers').values({ user_id: userId, provider: providerName, provider_customer_id: customerId })
    .onConflict((oc) => oc.doNothing()).execute();
}

/** Mirrors a provider subscription into `subscriptions`. Late, older events never overwrite newer state. */
async function applySubscription(tx: Transaction<DB>, deps: Deps, providerName: string, ev: BillingEvent & { kind: 'subscription' }) {
  const s: ProviderSubscription = ev.subscription;
  const existing = await tx.selectFrom('subscriptions').selectAll().where('provider', '=', providerName)
    .where('provider_subscription_id', '=', s.id).forUpdate().executeTakeFirst();
  if (existing && existing.provider_event_at > ev.createdAt) return 'stale';
  // A subscription we cancelled (account deleted) never grants again, even if the provider has not caught up yet.
  if (existing?.cancel_requested_at && GRANTING.has(s.status)) return 'stale';

  const userId = existing?.user_id ?? s.metadata.userId;
  const planKey = existing?.plan_key ?? s.metadata.planKey;
  const payerId = existing?.payer_user_id ?? s.metadata.payerUserId ?? userId;
  if (!(await userExists(tx, userId)) || !planKey) return 'unattributed';
  const plan = await tx.selectFrom('plans').select(['key', 'names']).where('key', '=', planKey).executeTakeFirst();
  if (!plan) return 'unattributed';

  const row = {
    status: s.status,
    billing_interval: s.interval,
    currency: s.currency,
    amount_minor: s.amountMinor,
    trial_end: s.trialEnd,
    current_period_end: s.currentPeriodEnd,
    cancel_at_period_end: s.cancelAtPeriodEnd,
    canceled_at: s.canceledAt,
    provider_customer_id: s.customerId,
    provider_event_at: ev.createdAt,
    updated_at: deps.now(),
  };
  if (existing) {
    await tx.updateTable('subscriptions').set(row).where('id', '=', existing.id).execute();
  } else {
    await tx.insertInto('subscriptions').values({
      id: newId(), user_id: userId!, payer_user_id: payerId && (await userExists(tx, payerId)) ? payerId : null, plan_key: planKey,
      provider: providerName, provider_subscription_id: s.id, ...row,
    }).execute();
  }
  if (payerId && (await userExists(tx, payerId))) await rememberCustomer(tx, providerName, payerId, s.customerId);

  // Tell people about changes they need to know about (always delivered: billing notices are account notices).
  const recipients = [...new Set([userId!, ...(payerId && payerId !== userId ? [payerId] : [])])];
  const payload = { planKey, status: s.status, trialEnd: s.trialEnd?.toISOString() ?? null, currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null };
  const wasGranting = existing ? GRANTING.has(existing.status) : false;
  const nowGranting = GRANTING.has(s.status);
  let kind: string | null = null;
  if (!wasGranting && nowGranting) kind = 'billing.subscription_started';
  else if (wasGranting && !nowGranting) kind = 'billing.subscription_ended';
  else if (existing && !existing.cancel_at_period_end && s.cancelAtPeriodEnd) kind = 'billing.cancellation_scheduled';
  if (kind) for (const r of recipients) await notify(tx, r, kind, payload);
  await audit(tx, { actorId: null, action: 'billing.subscription_synced', targetKind: 'user', targetId: userId!, metadata: { event: ev.type, eventId: ev.id, planKey, status: s.status } });
  return 'applied';
}

async function applyEvent(tx: Transaction<DB>, deps: Deps, providerName: string, ev: BillingEvent): Promise<string> {
  switch (ev.kind) {
    case 'checkout.completed': {
      // Completing checkout grants nothing by itself; the subscription events that follow do.
      const cs = await tx.selectFrom('checkout_sessions').selectAll().where('provider_session_id', '=', ev.sessionId).forUpdate().executeTakeFirst();
      if (!cs) return 'unattributed';
      if (cs.status === 'completed') return 'applied';
      await tx.updateTable('checkout_sessions').set({ status: 'completed', completed_at: deps.now() }).where('provider_session_id', '=', cs.provider_session_id).execute();
      await rememberCustomer(tx, providerName, cs.payer_user_id, ev.customerId);
      if (cs.coupon_code) {
        const r = await tx.insertInto('coupon_redemptions').values({ code: cs.coupon_code, user_id: cs.payer_user_id, provider_session_id: cs.provider_session_id })
          .onConflict((oc) => oc.doNothing()).returning('code').executeTakeFirst();
        if (r) await tx.updateTable('coupons').set((eb) => ({ redeemed_count: eb('redeemed_count', '+', 1) })).where('code', '=', cs.coupon_code).execute();
      }
      await audit(tx, { actorId: null, action: 'billing.checkout_completed', targetKind: 'user', targetId: cs.user_id, metadata: { eventId: ev.id, planKey: cs.plan_key, sessionId: cs.provider_session_id } });
      return 'applied';
    }
    case 'subscription':
      return applySubscription(tx, deps, providerName, ev);
    case 'invoice.payment_failed': {
      if (!ev.subscriptionId) return 'unattributed';
      const sub = await tx.selectFrom('subscriptions').selectAll().where('provider', '=', providerName)
        .where('provider_subscription_id', '=', ev.subscriptionId).forUpdate().executeTakeFirst();
      if (!sub) return 'unattributed';
      // The provider retries the payment; access continues as past_due until it gives up and cancels.
      if ((sub.status === 'active' || sub.status === 'trialing') && sub.provider_event_at <= ev.createdAt) {
        await tx.updateTable('subscriptions').set({ status: 'past_due', provider_event_at: ev.createdAt, updated_at: deps.now() }).where('id', '=', sub.id).execute();
      }
      await notify(tx, sub.payer_user_id ?? sub.user_id, 'billing.payment_failed', { planKey: sub.plan_key });
      await audit(tx, { actorId: null, action: 'billing.payment_failed', targetKind: 'user', targetId: sub.user_id, metadata: { eventId: ev.id, planKey: sub.plan_key } });
      return 'applied';
    }
    case 'ignored':
      return 'ignored';
  }
}

// ---------------------------------------------------------------- routes

function bilingual(v: unknown): Bilingual {
  const o = (v ?? {}) as Partial<Bilingual>;
  return { en: o.en ?? '', ar: o.ar ?? o.en ?? '' };
}

export const billingRoutes = [
  route(
    { method: 'get', path: '/v1/plans', summary: 'Plans and prices (public)', tag: 'billing', auth: 'none', query: PlansQuery, response: PlanList },
    async (ctx) => {
      const currency = ctx.query.currency;
      const [plans, prices] = await Promise.all([
        planRows(ctx.deps.db),
        ctx.deps.db.selectFrom('plan_prices').select(['plan_key', 'currency', 'billing_interval', 'amount_minor'])
          .where('active', '=', true).where('currency', '=', currency).orderBy('billing_interval').execute(),
      ]);
      const defaults = configuredDefaults(ctx.deps.config);
      return {
        currency,
        paymentsEnabled: ctx.deps.billing !== null,
        items: plans.filter((p) => p.active).map((p) => ({
          key: p.key,
          audience: p.audience as 'player' | 'scout' | 'organization',
          tier: p.tier as 'free' | 'pro' | 'organization' | 'club' | 'enterprise',
          name: bilingual(p.names),
          description: bilingual(p.descriptions),
          checkout: p.checkout_mode as 'none' | 'self_serve' | 'contact_sales',
          trialDays: p.trial_days,
          prices: prices.filter((x) => x.plan_key === p.key).map((x) => ({ currency: x.currency, interval: x.billing_interval as 'month' | 'year', amountMinor: x.amount_minor })),
          features: p.features.filter(isFeature).map((key) => ({ key, status: FEATURES[key] })),
          limits: planLimits(toPlanDefinition(p), defaults),
        })),
      };
    },
  ),

  route(
    { method: 'get', path: '/v1/me/entitlements', summary: 'My effective plan, features, limits and usage', tag: 'billing', auth: 'user', response: EntitlementsView },
    async (ctx) => {
      const me = ctx.me();
      const now = ctx.deps.now();
      const [ent, uploads, searches, slots, subs, customer, planNames] = await Promise.all([
        entitlementsFor(ctx.deps, me.userId, me.roles),
        uploadUsage(ctx.deps, me.userId),
        scoutSearchesUsed(ctx.deps.db, me.userId, now),
        shortlistSlotsUsed(ctx.deps.db, me.userId),
        ctx.deps.db.selectFrom('subscriptions').selectAll().where('user_id', '=', me.userId).orderBy('created_at', 'desc').execute(),
        ctx.deps.db.selectFrom('billing_customers').select('user_id').where('user_id', '=', me.userId).executeTakeFirst(),
        ctx.deps.db.selectFrom('plans').select(['key', 'names']).execute(),
      ]);
      const names = new Map(planNames.map((p) => [p.key, bilingual(p.names)]));
      // Ended subscriptions are history; only the ones still relevant are listed.
      const current = subs.filter((s) => !['canceled', 'incomplete_expired'].includes(s.status));
      return {
        plans: ent.plans,
        features: ent.features,
        limits: ent.limits,
        usage: {
          activeVideos: uploads.active, uploadsToday: uploads.today, scoutSearchesThisMonth: searches, shortlistSlotsUsed: slots.used,
          searchesResetAt: nextMonthStart(now).toISOString(),
        },
        subscriptions: current.map((s) => ({
          planKey: s.plan_key, planName: names.get(s.plan_key) ?? { en: s.plan_key, ar: s.plan_key },
          status: s.status as SubscriptionStatus, interval: s.billing_interval as 'month' | 'year' | null, currency: s.currency, amountMinor: s.amount_minor,
          trialEnd: s.trial_end?.toISOString() ?? null, currentPeriodEnd: s.current_period_end?.toISOString() ?? null,
          cancelAtPeriodEnd: s.cancel_at_period_end,
          grantsAccess: subscriptionGrants({ planKey: s.plan_key, status: s.status as SubscriptionStatus, currentPeriodEnd: s.current_period_end }, now),
          paidByOther: s.payer_user_id !== null && s.payer_user_id !== me.userId,
        })),
        hasBillingAccount: Boolean(customer),
        paymentsEnabled: ctx.deps.billing !== null,
      };
    },
  ),

  route(
    { method: 'post', path: '/v1/billing/coupons/validate', summary: 'Check a coupon or referral code for a plan before checkout', tag: 'billing', auth: 'user', body: CouponValidateRequest, response: CouponView, rateLimit: { max: 20, timeWindow: '1 hour' } },
    async (ctx) => {
      const me = ctx.me();
      const plan = await ctx.deps.db.selectFrom('plans').select('key').where('key', '=', ctx.body.planKey).where('active', '=', true).executeTakeFirst();
      if (!plan) throw notFound('plan');
      return couponView(await validCoupon(ctx.deps, ctx.body.code, plan, [me.userId], ctx.body.currency));
    },
  ),

  route(
    { method: 'post', path: '/v1/billing/checkout', summary: 'Start checkout for a paid plan; returns the payment page URL', tag: 'billing', auth: 'user', body: CheckoutRequest, response: CheckoutResponse, rateLimit: { max: 10, timeWindow: '1 hour' } },
    async (ctx) => {
      const pay = provider(ctx.deps);
      const me = ctx.me();
      const b = ctx.body;
      const db = ctx.deps.db;
      const subjectId = b.forUserId ?? me.userId;
      // Only a guardian may name someone else; anyone else learns nothing about that account.
      if (subjectId !== me.userId && !me.guardianOf.includes(subjectId)) throw forbidden('FORBIDDEN', 'cannot buy a plan for another user');

      const subject = subjectId === me.userId
        ? { id: me.userId, status: me.status as string, roles: me.roles, ageBand: me.ageBand }
        : await (async () => {
          const u = await db.selectFrom('users').leftJoin('age_records', 'age_records.user_id', 'users.id')
            .select(['users.id', 'users.status', 'age_records.age_band']).where('users.id', '=', subjectId).executeTakeFirst();
          if (!u) throw notFound('user');
          const roles = await db.selectFrom('user_roles').select('role').where('user_id', '=', u.id).execute();
          return { id: u.id, status: u.status, roles: roles.map((r) => r.role as Role), ageBand: (u.age_band ?? 'u13') as AgeBand };
        })();
      // Minors cannot buy; a guardian buys for them from their own account.
      ctx.authorize({ kind: 'billing.purchase', subjectId: subject.id, subjectMinor: isMinor(subject.ageBand) });
      if (subject.status !== 'active') throw forbidden('ACCOUNT_INACTIVE', 'this account cannot take a plan right now');

      const plan = await db.selectFrom('plans').selectAll().where('key', '=', b.planKey).where('active', '=', true).executeTakeFirst();
      if (!plan) throw notFound('plan');
      if (plan.checkout_mode === 'contact_sales') throw new ApiError(400, 'CONTACT_SALES', 'this plan is arranged with our team; contact sales');
      if (plan.checkout_mode !== 'self_serve') throw new ApiError(400, 'PLAN_NOT_PURCHASABLE', 'this plan is free; there is nothing to buy');
      const audience = audienceAllowed(plan.audience as 'player' | 'scout' | 'organization', subject.roles);
      if (!audience.allowed) throw forbidden(audience.code, plan.audience === 'player' ? 'player plans are for player accounts' : 'scout plans are for verified scouts');

      const price = await db.selectFrom('plan_prices').selectAll().where('plan_key', '=', plan.key).where('currency', '=', b.currency)
        .where('billing_interval', '=', b.interval).where('active', '=', true).executeTakeFirst();
      if (!price) throw new ApiError(400, 'PRICE_NOT_AVAILABLE', `this plan is not sold ${b.interval === 'year' ? 'yearly' : 'monthly'} in ${b.currency}`);

      // One live subscription per audience; changes and cancellation go through the billing portal.
      const now = ctx.deps.now();
      const sameAudience = await db.selectFrom('subscriptions').innerJoin('plans', 'plans.key', 'subscriptions.plan_key')
        .select(['subscriptions.plan_key', 'subscriptions.status', 'subscriptions.current_period_end'])
        .where('subscriptions.user_id', '=', subject.id).where('plans.audience', '=', plan.audience).execute();
      if (sameAudience.some((s) => subscriptionGrants({ planKey: s.plan_key, status: s.status as SubscriptionStatus, currentPeriodEnd: s.current_period_end }, now))) {
        throw conflict('ALREADY_SUBSCRIBED', 'you already have a plan of this kind; manage it from billing settings');
      }
      // A free trial is offered once per audience.
      const trialDays = sameAudience.length === 0 ? plan.trial_days : 0;

      const coupon = b.couponCode ? await validCoupon(ctx.deps, b.couponCode, plan, [...new Set([me.userId, subject.id])], b.currency) : null;
      const [customer, payer] = await Promise.all([
        db.selectFrom('billing_customers').select('provider_customer_id').where('user_id', '=', me.userId).where('provider', '=', pay.name).executeTakeFirst(),
        db.selectFrom('users').select('email').where('id', '=', me.userId).executeTakeFirst(),
      ]);
      const name = bilingual(plan.names).en;
      const session = await pay.createCheckoutSession({
        line: { productName: `KICKSCOUT ${name}`, currency: price.currency, amountMinor: price.amount_minor, interval: b.interval, providerPriceId: price.provider_price_id },
        customerId: customer?.provider_customer_id ?? null,
        customerEmail: customer ? null : (payer?.email ?? null),
        trialDays,
        promotionCodeId: coupon?.provider_promotion_code_id ?? null,
        // The success page only says the payment is being confirmed; the plan changes when the webhook arrives.
        successUrl: webUrl(ctx.deps, '/settings?checkout=success#billing'),
        cancelUrl: webUrl(ctx.deps, '/pricing?checkout=cancelled'),
        metadata: { userId: subject.id, payerUserId: me.userId, planKey: plan.key, ...(coupon ? { couponCode: coupon.code } : {}) },
      });
      await db.transaction().execute(async (tx) => {
        await tx.insertInto('checkout_sessions').values({
          provider_session_id: session.id, provider: pay.name, user_id: subject.id, payer_user_id: me.userId, plan_key: plan.key, price_id: price.id,
          coupon_code: coupon?.code ?? null, trial_days: trialDays,
        }).execute();
        await audit(tx, { actorId: me.userId, action: 'billing.checkout_started', targetKind: 'user', targetId: subject.id, metadata: { planKey: plan.key, interval: b.interval, currency: price.currency, trialDays, coupon: coupon?.code ?? null } });
      });
      return { url: session.url, sessionId: session.id, planKey: plan.key, interval: b.interval, currency: price.currency, amountMinor: price.amount_minor, trialDays };
    },
  ),

  route(
    { method: 'post', path: '/v1/billing/portal', summary: 'Open the billing portal to change payment details or cancel (one click)', tag: 'billing', auth: 'user', response: PortalResponse, rateLimit: { max: 20, timeWindow: '1 hour' } },
    async (ctx) => {
      const pay = provider(ctx.deps);
      const me = ctx.me();
      const customer = await ctx.deps.db.selectFrom('billing_customers').select('provider_customer_id').where('user_id', '=', me.userId)
        .where('provider', '=', pay.name).executeTakeFirst();
      if (!customer) throw new ApiError(404, 'NO_BILLING_ACCOUNT', 'you have no paid plan to manage');
      return pay.createPortalSession({ customerId: customer.provider_customer_id, returnUrl: webUrl(ctx.deps, '/settings#billing') });
    },
  ),

  route(
    { method: 'get', path: '/v1/cron/billing', summary: 'Scheduled billing maintenance: retries provider cancellations that failed (Bearer CRON_SECRET)', tag: 'billing', auth: 'none', response: BillingMaintenanceReport },
    async (ctx) => {
      const secret = ctx.deps.config.CRON_SECRET;
      if (!secret) throw new ApiError(503, 'CRON_NOT_CONFIGURED', 'set CRON_SECRET to enable scheduled maintenance');
      if (!bearerIs(ctx.req.headers.authorization, secret)) throw new ApiError(401, 'UNAUTHENTICATED', 'cron secret required');
      return retryPendingCancellations(ctx.deps, ctx.req.log);
    },
  ),

  route(
    { method: 'post', path: '/v1/billing/webhook', summary: 'Payment provider webhook (signed; raw body)', tag: 'billing', auth: 'none', response: WebhookAck, rawBody: true, rateLimit: { max: 600, timeWindow: '1 minute' } },
    async (ctx) => {
      const pay = provider(ctx.deps);
      const raw = ctx.req.body;
      const header = ctx.req.headers[pay.signatureHeader];
      let event: BillingEvent;
      try {
        if (!Buffer.isBuffer(raw)) throw new WebhookSignatureError('empty body');
        event = pay.parseWebhook(raw, typeof header === 'string' ? header : undefined);
      } catch (err) {
        if (err instanceof WebhookSignatureError) throw new ApiError(400, 'INVALID_SIGNATURE', 'webhook signature verification failed');
        throw err;
      }
      // The event id is recorded in the same transaction as its effects: a replay finds it and changes nothing,
      // and a failure rolls both back so the provider's retry is processed in full.
      const outcome = await ctx.deps.db.transaction().execute(async (tx) => {
        const fresh = await tx.insertInto('billing_events').values({ provider: pay.name, event_id: event.id, type: event.type })
          .onConflict((oc) => oc.doNothing()).returning('event_id').executeTakeFirst();
        if (!fresh) return 'duplicate';
        return applyEvent(tx, ctx.deps, pay.name, event);
      });
      if (outcome === 'unattributed' || outcome === 'stale') ctx.req.log.warn({ eventId: event.id, type: event.type, outcome }, 'billing webhook not applied');
      return { received: true as const, duplicate: outcome === 'duplicate' };
    },
  ),
];
