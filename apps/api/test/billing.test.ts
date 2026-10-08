import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { createTestEnv } from './helpers.js';
import type { TestEnv } from './helpers.js';
import { FAKE_WEBHOOK_SECRET, FakePaymentProvider, signedStripeEvent, stripeSubscription } from './fake-payments.js';
import { StripePaymentProvider, normalizeStripeEvent, normalizeSubscription } from '../src/platform/billing/stripe.js';
import { loadConfig } from '../src/config.js';

let env: TestEnv;
const fake = new FakePaymentProvider();
beforeAll(async () => {
  env = await createTestEnv({}, { billing: fake });
});
afterAll(async () => {
  await env?.close();
});

type Json = Record<string, any>;
type User = { token: string; userId: string };

async function call(method: string, url: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.raw !== undefined) headers['content-type'] = 'application/json';
  const payload = opts.raw ?? (opts.body !== undefined ? (opts.body as Json) : undefined);
  const res = await env.app.inject({ method: method as 'GET', url, headers, ...(payload !== undefined ? { payload } : {}) });
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Json };
}

let n = 0;
async function user(roles: string[] = ['player'], dob = '1995-04-02', claims: Json = {}): Promise<User> {
  const sub = `billing-${++n}`;
  const token = await env.token(sub, claims);
  const r = await call('POST', '/v1/onboarding/register', { token, body: { handle: `bill_${n}`, displayName: `Bill ${n}`, dob, countryCode: 'EG', roles } });
  expect(r.status).toBe(201);
  return { token, userId: r.body.userId };
}
async function scoutUser(): Promise<User> {
  const u = await user(['fan']);
  await env.db.insertInto('user_roles').values({ user_id: u.userId, role: 'scout' }).execute();
  return u;
}

/** Sends a signed webhook through the real route, as Stripe would. */
async function webhook(type: string, object: Record<string, unknown>, opts: { id?: string; created?: number } = {}) {
  const e = signedStripeEvent(type, object, opts);
  const res = await call('POST', '/v1/billing/webhook', { raw: e.payload, headers: { 'stripe-signature': e.signature } });
  return { ...res, event: e };
}

let subSeq = 0;
/** Gives a user a paid plan the way production does: through subscription webhooks. */
async function subscribe(u: User, planKey: string, status = 'active') {
  const id = `sub_test_${++subSeq}`;
  const r = await webhook('customer.subscription.created', stripeSubscription({ id, customer: `cus_${u.userId.slice(0, 8)}`, status, metadata: { userId: u.userId, payerUserId: u.userId, planKey } }));
  expect(r.status).toBe(200);
  return id;
}

const entitlements = async (u: User) => (await call('GET', '/v1/me/entitlements', { token: u.token })).body;
const checkout = (u: User, body: Json) => call('POST', '/v1/billing/checkout', { token: u.token, body });
const notifications = (userId: string, kind: string) =>
  env.db.selectFrom('notifications').select('id').where('user_id', '=', userId).where('kind', '=', kind).execute().then((r) => r.length);

// -------------------------------------------------------------------------------------------- plans
describe('plans', () => {
  it('lists the configured plans and USD prices publicly, with the free player limits from config', async () => {
    const r = await call('GET', '/v1/plans');
    expect(r.status).toBe(200);
    expect(r.body.currency).toBe('USD');
    expect(r.body.paymentsEnabled).toBe(true);
    const byKey = Object.fromEntries(r.body.items.map((p: Json) => [p.key, p]));
    expect(Object.keys(byKey)).toEqual(['player_free', 'player_pro', 'scout_free', 'scout_pro', 'organization', 'club_pro', 'enterprise']);
    expect(byKey.player_free).toMatchObject({ checkout: 'none', prices: [], limits: { maxVideoSeconds: 60, maxActiveVideos: 20, maxUploadsPerDay: 10 } });
    expect(byKey.player_pro).toMatchObject({
      checkout: 'self_serve', trialDays: 7, limits: { maxVideoSeconds: 180, maxActiveVideos: 100 },
      prices: [{ currency: 'USD', interval: 'month', amountMinor: 499 }, { currency: 'USD', interval: 'year', amountMinor: 4900 }],
    });
    expect(byKey.scout_free.limits).toMatchObject({ scoutSearchesPerMonth: 20, shortlistSlots: 10 });
    expect(byKey.scout_pro).toMatchObject({ trialDays: 14, limits: { scoutSearchesPerMonth: null, shortlistSlots: null } });
    expect(byKey.scout_pro.prices.map((p: Json) => p.amountMinor)).toEqual([2900, 24900]);
    expect(byKey.organization).toMatchObject({ trialDays: 14, limits: { seats: 5 }, prices: [{ interval: 'month', amountMinor: 9900 }] });
    expect(byKey.club_pro.prices).toEqual([{ currency: 'USD', interval: 'month', amountMinor: 24900 }]);
    expect(byKey.enterprise).toMatchObject({ checkout: 'contact_sales', prices: [] });
    // Features say honestly which ones are not built yet.
    expect(byKey.player_pro.features).toContainEqual({ key: 'FEATURE_PRO_ANALYTICS', status: 'coming_soon' });
    expect(byKey.player_pro.features).toContainEqual({ key: 'FEATURE_EXTENDED_UPLOADS', status: 'live' });
  });

  it('reads prices from the database, so a new currency is a row and not a code change', async () => {
    expect((await call('GET', '/v1/plans?currency=EUR')).body.items.every((p: Json) => p.prices.length === 0)).toBe(true);
    await env.db.insertInto('plan_prices').values({ id: crypto.randomUUID(), plan_key: 'player_pro', currency: 'EUR', billing_interval: 'month', amount_minor: 459 }).execute();
    const eur = (await call('GET', '/v1/plans?currency=EUR')).body.items.find((p: Json) => p.key === 'player_pro');
    expect(eur.prices).toEqual([{ currency: 'EUR', interval: 'month', amountMinor: 459 }]);
    expect((await call('GET', '/v1/plans?currency=eur')).status).toBe(400);
  });
});

// -------------------------------------------------------------------------------------------- not configured
describe('without a payment provider', () => {
  it('answers 503 BILLING_NOT_CONFIGURED and records nothing', async () => {
    const p = await user();
    env.deps.billing = null;
    try {
      const sessionsBefore = (await env.db.selectFrom('checkout_sessions').select('provider_session_id').execute()).length;
      for (const [url, body] of [['/v1/billing/checkout', { planKey: 'player_pro', interval: 'month' }], ['/v1/billing/portal', undefined]] as const) {
        const r = await call('POST', url, { token: p.token, body });
        expect(r.status).toBe(503);
        expect(r.body.code).toBe('BILLING_NOT_CONFIGURED');
      }
      const e = signedStripeEvent('customer.subscription.created', stripeSubscription({ id: 'sub_unconfigured', customer: 'cus_x', status: 'active', metadata: { userId: p.userId, payerUserId: p.userId, planKey: 'player_pro' } }));
      const hook = await call('POST', '/v1/billing/webhook', { raw: e.payload, headers: { 'stripe-signature': e.signature } });
      expect(hook.status).toBe(503);
      expect((await call('GET', '/v1/plans')).body.paymentsEnabled).toBe(false);
      const ent = await entitlements(p);
      expect(ent).toMatchObject({ plans: ['player_free'], paymentsEnabled: false, subscriptions: [] });
      expect((await env.db.selectFrom('checkout_sessions').select('provider_session_id').execute()).length).toBe(sessionsBefore);
    } finally {
      env.deps.billing = fake;
    }
  });
});

// -------------------------------------------------------------------------------------------- checkout
describe('checkout', () => {
  it('creates a checkout session with the database price and trial, and grants nothing yet', async () => {
    const p = await user();
    const r = await checkout(p, { planKey: 'player_pro', interval: 'month' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ planKey: 'player_pro', interval: 'month', currency: 'USD', amountMinor: 499, trialDays: 7 });
    expect(r.body.url).toMatch(/^https:\/\/checkout\.fake\.test\//);
    const sent = fake.checkouts.at(-1)!;
    expect(sent).toMatchObject({
      line: { currency: 'USD', amountMinor: 499, interval: 'month', providerPriceId: null }, trialDays: 7, promotionCodeId: null,
      metadata: { userId: p.userId, payerUserId: p.userId, planKey: 'player_pro' },
      successUrl: 'https://web.test/settings?checkout=success#billing', cancelUrl: 'https://web.test/pricing?checkout=cancelled',
    });
    // Coming back from the payment page proves nothing: the plan is unchanged until the provider confirms.
    const ent = await entitlements(p);
    expect(ent.plans).toEqual(['player_free']);
    expect(ent.limits.maxVideoSeconds).toBe(60);
    expect(await env.db.selectFrom('subscriptions').select('id').where('user_id', '=', p.userId).execute()).toEqual([]);

    const yearly = await checkout(p, { planKey: 'player_pro', interval: 'year' });
    expect(yearly.body).toMatchObject({ amountMinor: 4900, trialDays: 7 });
  });

  it('refuses free, contact-sales, unavailable and wrong-audience plans with clear codes', async () => {
    const p = await user();
    expect((await checkout(p, { planKey: 'player_free', interval: 'month' })).body.code).toBe('PLAN_NOT_PURCHASABLE');
    expect((await checkout(p, { planKey: 'enterprise', interval: 'month' })).body.code).toBe('CONTACT_SALES');
    expect((await checkout(p, { planKey: 'scout_pro', interval: 'month' })).body.code).toBe('SCOUT_VERIFICATION_REQUIRED');
    expect((await checkout(p, { planKey: 'nope_plan', interval: 'month' })).status).toBe(404);
    const s = await scoutUser();
    expect((await checkout(s, { planKey: 'player_pro', interval: 'month' })).body.code).toBe('ROLE_REQUIRED');
    expect((await checkout(s, { planKey: 'club_pro', interval: 'year' })).body.code).toBe('PRICE_NOT_AVAILABLE');
    expect((await checkout(s, { planKey: 'scout_pro', interval: 'year', currency: 'GBP' })).body.code).toBe('PRICE_NOT_AVAILABLE');
    expect((await checkout(s, { planKey: 'scout_pro', interval: 'year' })).body).toMatchObject({ amountMinor: 24900, trialDays: 14 });
  });

  it('blocks minors from buying; their guardian buys for them', async () => {
    const kid = await user(['player'], '2011-03-15');
    const guardian = await user(['fan']);
    const stranger = await user(['fan']);
    // Activated as the consent flow would (tested in api.test.ts).
    await env.db.insertInto('guardian_relationships').values({ guardian_user_id: guardian.userId, minor_user_id: kid.userId }).execute();
    await env.db.updateTable('users').set({ status: 'active' }).where('id', '=', kid.userId).execute();

    const own = await checkout(kid, { planKey: 'player_pro', interval: 'month' });
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('GUARDIAN_REQUIRED');
    expect((await checkout(stranger, { planKey: 'player_pro', interval: 'month', forUserId: kid.userId })).body.code).toBe('FORBIDDEN');

    const before = fake.checkouts.length;
    const byGuardian = await checkout(guardian, { planKey: 'player_pro', interval: 'month', forUserId: kid.userId });
    expect(byGuardian.status).toBe(200);
    expect(fake.checkouts.length).toBe(before + 1);
    expect(fake.checkouts.at(-1)!.metadata).toMatchObject({ userId: kid.userId, payerUserId: guardian.userId });

    // The plan lands on the minor; the guardian holds the billing account.
    await webhook('customer.subscription.created', stripeSubscription({ id: 'sub_kid', customer: 'cus_guardian', status: 'trialing', metadata: fake.checkouts.at(-1)!.metadata as unknown as Record<string, string> }));
    const kidEnt = await entitlements(kid);
    expect(kidEnt.plans).toContain('player_pro');
    expect(kidEnt.subscriptions[0]).toMatchObject({ planKey: 'player_pro', paidByOther: true });
    expect(kidEnt.hasBillingAccount).toBe(false);
    expect((await entitlements(guardian)).hasBillingAccount).toBe(true);
    expect((await call('POST', '/v1/billing/portal', { token: kid.token })).body.code).toBe('NO_BILLING_ACCOUNT');
  });
});

// -------------------------------------------------------------------------------------------- lifecycle
describe('subscription lifecycle', () => {
  it('follows checkout, trial, renewal, failed payment, scheduled cancellation and cancellation', async () => {
    const p = await user();
    const start = await checkout(p, { planKey: 'player_pro', interval: 'month' });
    const sessionId = start.body.sessionId as string;
    const meta = { userId: p.userId, payerUserId: p.userId, planKey: 'player_pro' };
    const t0 = Math.floor(Date.now() / 1000) - 100;

    // Checkout completed: the session and customer are recorded, but nothing is granted yet.
    const done = await webhook('checkout.session.completed', { id: sessionId, object: 'checkout.session', customer: 'cus_life', subscription: 'sub_life', metadata: meta, client_reference_id: p.userId }, { created: t0 });
    expect(done.status).toBe(200);
    expect((await env.db.selectFrom('checkout_sessions').select('status').where('provider_session_id', '=', sessionId).executeTakeFirstOrThrow()).status).toBe('completed');
    expect((await entitlements(p)).plans).toEqual(['player_free']);

    // Trial starts.
    const trialEnd = new Date(Date.now() + 7 * 86_400_000);
    const created = await webhook('customer.subscription.created', stripeSubscription({ id: 'sub_life', customer: 'cus_life', status: 'trialing', metadata: meta, trialEnd, periodEnd: trialEnd }), { created: t0 + 1 });
    expect(created.body).toEqual({ received: true, duplicate: false });
    let ent = await entitlements(p);
    expect(ent.plans).toEqual(['player_free', 'player_pro']);
    expect(ent.limits).toMatchObject({ maxVideoSeconds: 180, maxActiveVideos: 100 });
    expect(ent.features).toContain('FEATURE_PRO_ANALYTICS');
    expect(ent.subscriptions).toEqual([expect.objectContaining({ status: 'trialing', trialEnd: new Date(Math.floor(trialEnd.getTime() / 1000) * 1000).toISOString(), amountMinor: 499, interval: 'month', grantsAccess: true, cancelAtPeriodEnd: false })]);
    expect(ent.hasBillingAccount).toBe(true);
    expect(await notifications(p.userId, 'billing.subscription_started')).toBe(1);

    // The same event delivered again changes nothing.
    const replay = await call('POST', '/v1/billing/webhook', { raw: created.event.payload, headers: { 'stripe-signature': created.event.signature } });
    expect(replay.body).toEqual({ received: true, duplicate: true });
    expect(await notifications(p.userId, 'billing.subscription_started')).toBe(1);
    expect((await env.db.selectFrom('billing_events').select('event_id').where('event_id', '=', created.event.event.id).execute()).length).toBe(1);

    // Trial converts to paid.
    await webhook('customer.subscription.updated', stripeSubscription({ id: 'sub_life', customer: 'cus_life', status: 'active', metadata: meta }), { created: t0 + 2 });
    expect((await entitlements(p)).subscriptions[0].status).toBe('active');

    // An older event arriving late does not roll the state back.
    await webhook('customer.subscription.updated', stripeSubscription({ id: 'sub_life', customer: 'cus_life', status: 'incomplete', metadata: meta }), { created: t0 + 1 });
    expect((await entitlements(p)).subscriptions[0].status).toBe('active');

    // A second plan of the same kind is refused; changes go through the portal.
    expect((await checkout(p, { planKey: 'player_pro', interval: 'year' })).body.code).toBe('ALREADY_SUBSCRIBED');
    const portal = await call('POST', '/v1/billing/portal', { token: p.token });
    expect(portal.body.url).toBe('https://billing.fake.test/p/session/cus_life');
    expect(fake.portals.at(-1)).toEqual({ customerId: 'cus_life', returnUrl: 'https://web.test/settings#billing' });

    // Renewal payment fails: access continues while the provider retries, and the payer is told.
    await webhook('invoice.payment_failed', { id: 'in_1', object: 'invoice', customer: 'cus_life', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_life' } } }, { created: t0 + 3 });
    ent = await entitlements(p);
    expect(ent.subscriptions[0]).toMatchObject({ status: 'past_due', grantsAccess: true });
    expect(ent.limits.maxVideoSeconds).toBe(180);
    expect(await notifications(p.userId, 'billing.payment_failed')).toBe(1);

    // Cancelled in the portal: access until the period ends, and the user is told when.
    await webhook('customer.subscription.updated', stripeSubscription({ id: 'sub_life', customer: 'cus_life', status: 'active', metadata: meta, cancelAtPeriodEnd: true }), { created: t0 + 4 });
    ent = await entitlements(p);
    expect(ent.subscriptions[0]).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect(await notifications(p.userId, 'billing.cancellation_scheduled')).toBe(1);

    // Period over: back to free.
    await webhook('customer.subscription.deleted', stripeSubscription({ id: 'sub_life', customer: 'cus_life', status: 'canceled', metadata: meta, canceledAt: new Date() }), { created: t0 + 5 });
    ent = await entitlements(p);
    expect(ent.plans).toEqual(['player_free']);
    expect(ent.limits.maxVideoSeconds).toBe(60);
    expect(ent.subscriptions).toEqual([]);
    expect(await notifications(p.userId, 'billing.subscription_ended')).toBe(1);

    // Buying again works, but the free trial was already used.
    expect((await checkout(p, { planKey: 'player_pro', interval: 'month' })).body.trialDays).toBe(0);
    const audits = await env.db.selectFrom('audit_logs').select('action').where('target_id', '=', p.userId).where('action', 'like', 'billing.%').execute();
    expect(audits.map((a) => a.action)).toContain('billing.checkout_completed');
  });

  it('ignores signed events it cannot attribute to a user and plan, without failing the delivery', async () => {
    const r = await webhook('customer.subscription.created', stripeSubscription({ id: 'sub_orphan', customer: 'cus_orphan', status: 'active', metadata: {} }));
    expect(r.status).toBe(200);
    expect(await env.db.selectFrom('subscriptions').select('id').where('provider_subscription_id', '=', 'sub_orphan').execute()).toEqual([]);
    const other = await webhook('charge.succeeded', { id: 'ch_1', object: 'charge' });
    expect(other.body).toEqual({ received: true, duplicate: false });
  });
});

// -------------------------------------------------------------------------------------------- webhook security
describe('webhook signatures', () => {
  const object = () => stripeSubscription({ id: 'sub_forged', customer: 'cus_forged', status: 'active', metadata: { userId: crypto.randomUUID(), payerUserId: crypto.randomUUID(), planKey: 'scout_pro' } });

  it('rejects missing, wrong and tampered signatures before touching the database', async () => {
    const before = (await env.db.selectFrom('billing_events').select('event_id').execute()).length;
    const e = signedStripeEvent('customer.subscription.created', object());
    const wrongSecret = signedStripeEvent('customer.subscription.created', object(), { secret: 'whsec_someone_else' });
    const tampered = e.payload.replace('"active"', '"trialing"');
    for (const [raw, sig] of [[e.payload, undefined], [e.payload, 't=1,v1=deadbeef'], [wrongSecret.payload, wrongSecret.signature], [tampered, e.signature]] as const) {
      const r = await call('POST', '/v1/billing/webhook', { raw, headers: sig ? { 'stripe-signature': sig } : {} });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('INVALID_SIGNATURE');
    }
    // A stale signature (replayed long after it was made) is refused too.
    const old = signedStripeEvent('customer.subscription.created', object());
    const staleSig = Stripe.webhooks.generateTestHeaderString({ payload: old.payload, secret: FAKE_WEBHOOK_SECRET, timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect((await call('POST', '/v1/billing/webhook', { raw: old.payload, headers: { 'stripe-signature': staleSig } })).body.code).toBe('INVALID_SIGNATURE');
    expect((await env.db.selectFrom('billing_events').select('event_id').execute()).length).toBe(before);
  });

  it('verifies with the real Stripe provider over the raw request body', async () => {
    env.deps.billing = new StripePaymentProvider('sk_test_dummy_not_used_for_network', FAKE_WEBHOOK_SECRET);
    try {
      const p = await user();
      const good = signedStripeEvent('customer.subscription.created', stripeSubscription({ id: 'sub_real', customer: 'cus_real', status: 'active', metadata: { userId: p.userId, payerUserId: p.userId, planKey: 'player_pro' } }));
      // Re-serialising the JSON (as a parsed body would) breaks the signature; the route must use the exact bytes.
      const pretty = JSON.stringify(JSON.parse(good.payload), null, 2);
      expect((await call('POST', '/v1/billing/webhook', { raw: pretty, headers: { 'stripe-signature': good.signature } })).status).toBe(400);
      const ok = await call('POST', '/v1/billing/webhook', { raw: good.payload, headers: { 'stripe-signature': good.signature } });
      expect(ok.status).toBe(200);
      expect((await entitlements(p)).plans).toContain('player_pro');
    } finally {
      env.deps.billing = fake;
    }
  });
});

// -------------------------------------------------------------------------------------------- quotas
describe('plan limits', () => {
  const startUpload = (u: User) => call('POST', '/v1/uploads', { token: u.token, body: { contentType: 'video/mp4', sizeBytes: 1000, title: 'Rabona', rightsConfirmed: true } });
  const maxDuration = (videoId: string) => env.db.selectFrom('videos').select('max_duration_ms').where('id', '=', videoId).executeTakeFirstOrThrow().then((r) => r.max_duration_ms);

  it('takes upload length and video caps from the plan in the database', async () => {
    const free = await user();
    expect(await maxDuration((await startUpload(free)).body.videoId)).toBe(60_000);

    const pro = await user();
    await subscribe(pro, 'player_pro', 'trialing');
    expect(await maxDuration((await startUpload(pro)).body.videoId)).toBe(180_000);

    // Limits are configuration: changing a plan row changes enforcement without a deploy.
    await env.db.updateTable('plans').set({ limits: JSON.stringify({ maxVideoSeconds: 120, maxActiveVideos: 100, maxUploadsPerDay: 30 }) }).where('key', '=', 'player_pro').execute();
    await env.db.updateTable('plans').set({ limits: JSON.stringify({ maxActiveVideos: 1 }) }).where('key', '=', 'player_free').execute();
    try {
      expect(await maxDuration((await startUpload(pro)).body.videoId)).toBe(120_000);
      const over = await startUpload(free);
      expect(over.status).toBe(403);
      expect(over.body.code).toBe('QUOTA_ACTIVE_VIDEOS');
      // The paid plan's own cap still applies on top of the free one.
      expect((await entitlements(pro)).usage).toMatchObject({ activeVideos: 2, uploadsToday: 2 });
      expect((await startUpload(pro)).status).toBe(201);
    } finally {
      await env.db.updateTable('plans').set({ limits: JSON.stringify({ maxVideoSeconds: 180, maxActiveVideos: 100, maxUploadsPerDay: 30 }) }).where('key', '=', 'player_pro').execute();
      await env.db.updateTable('plans').set({ limits: '{}' }).where('key', '=', 'player_free').execute();
    }
  });

  it('meters Scout Free searches per month, not counting further pages, and lifts the cap with Scout Pro', async () => {
    await user(); await user(); // at least two discoverable players so a second page exists
    const s = await scoutUser();
    const search = (q = '') => call('GET', `/v1/scout/players?limit=1${q}`, { token: s.token });
    const first = await search();
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toBeTruthy();
    const page2 = await search(`&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(page2.status).toBe(200);
    expect((await entitlements(s)).usage.scoutSearchesThisMonth).toBe(1);

    for (let i = 1; i < 20; i++) expect((await search()).status).toBe(200);
    const over = await search();
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('QUOTA_SCOUT_SEARCHES');
    const ent = await entitlements(s);
    expect(ent.usage.scoutSearchesThisMonth).toBe(20);
    expect(ent.limits.scoutSearchesPerMonth).toBe(20);
    expect(new Date(ent.usage.searchesResetAt).getUTCDate()).toBe(1);

    await subscribe(s, 'scout_pro', 'trialing');
    expect((await search()).status).toBe(200);
    expect((await entitlements(s)).limits.scoutSearchesPerMonth).toBeNull();
  });

  it('caps Scout Free at 10 shortlist slots across lists, counting each player once', async () => {
    const players: User[] = [];
    for (let i = 0; i < 11; i++) players.push(await user());
    const s = await scoutUser();
    const list = async (name: string) => (await call('POST', '/v1/scout/shortlists', { token: s.token, body: { name } })).body.id as string;
    const a = await list('Wingers');
    const b = await list('Shortlist B');
    const add = (listId: string, p: User) => call('PUT', `/v1/scout/shortlists/${listId}/players/${p.userId}`, { token: s.token });

    for (const p of players.slice(0, 10)) expect((await add(a, p)).status).toBe(204);
    // The same player on another list uses no extra slot; re-adding is harmless.
    expect((await add(b, players[0]!)).status).toBe(204);
    expect((await add(a, players[0]!)).status).toBe(204);
    const over = await add(b, players[10]!);
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('QUOTA_SHORTLIST_SLOTS');
    expect((await entitlements(s)).usage.shortlistSlotsUsed).toBe(10);

    // Freeing a slot (removing the player from every list) lets a new player in.
    await call('DELETE', `/v1/scout/shortlists/${a}/players/${players[1]!.userId}`, { token: s.token });
    expect((await add(b, players[10]!)).status).toBe(204);

    await subscribe(s, 'scout_pro');
    const extra = await user();
    expect((await add(a, players[1]!)).status).toBe(204);
    expect((await add(a, extra)).status).toBe(204);
  });
});

// -------------------------------------------------------------------------------------------- coupons
describe('coupons and referral codes', () => {
  let p: User;
  beforeAll(async () => {
    p = await user();
    const day = 86_400_000;
    await env.db.insertInto('coupons').values([
      { code: 'WELCOME10', percent_off: 10, provider_promotion_code_id: 'promo_welcome10', duration: 'once' },
      { code: 'NOPROVIDER', percent_off: 10 },
      { code: 'EXPIRED', percent_off: 50, provider_promotion_code_id: 'promo_x', valid_until: new Date(Date.now() - day) },
      { code: 'SCOUTSONLY', percent_off: 20, provider_promotion_code_id: 'promo_s', plan_keys: ['scout_pro'] },
      { code: 'FIVEOFF', amount_off_minor: 500, currency: 'EUR', provider_promotion_code_id: 'promo_eur' },
      { code: 'REF-SELF', kind: 'referral', referrer_user_id: p.userId, percent_off: 15, provider_promotion_code_id: 'promo_ref' },
    ]).execute();
  });
  const validate = (code: string, planKey = 'player_pro') => call('POST', '/v1/billing/coupons/validate', { token: p.token, body: { code, planKey } });

  it('validates codes with a reason for each refusal', async () => {
    expect((await validate('welcome10')).body).toEqual({ code: 'WELCOME10', kind: 'coupon', percentOff: 10, amountOffMinor: null, currency: null, duration: 'once', durationMonths: null });
    expect((await validate('UNKNOWN')).body).toMatchObject({ status: 400, code: 'COUPON_INVALID' });
    expect((await validate('EXPIRED')).body.detail).toMatch(/expired/);
    expect((await validate('SCOUTSONLY')).body.detail).toMatch(/does not apply to this plan/);
    expect((await validate('FIVEOFF')).body.detail).toMatch(/currency/);
    expect((await validate('REF-SELF')).body.detail).toMatch(/own referral/);
    expect((await validate('NOPROVIDER')).body.code).toBe('COUPON_NOT_AVAILABLE');
  });

  it('applies a valid code at checkout through the provider promotion code, once per buyer', async () => {
    const r = await checkout(p, { planKey: 'player_pro', interval: 'month', couponCode: 'WELCOME10' });
    expect(r.status).toBe(200);
    expect(fake.checkouts.at(-1)).toMatchObject({ promotionCodeId: 'promo_welcome10', metadata: { couponCode: 'WELCOME10' } });
    expect((await checkout(p, { planKey: 'player_pro', interval: 'month', couponCode: 'EXPIRED' })).body.code).toBe('COUPON_INVALID');

    await webhook('checkout.session.completed', { id: r.body.sessionId, object: 'checkout.session', customer: 'cus_coupon', subscription: null, metadata: {} });
    const c = await env.db.selectFrom('coupons').select('redeemed_count').where('code', '=', 'WELCOME10').executeTakeFirstOrThrow();
    expect(c.redeemed_count).toBe(1);
    expect((await validate('WELCOME10')).body.detail).toMatch(/already used/);
  });
});

// -------------------------------------------------------------------------------------------- provider details
describe('Stripe event normalisation and configuration', () => {
  it('reads subscription periods from the item (current API) or the subscription (older API)', () => {
    const current = normalizeSubscription(stripeSubscription({ id: 'sub_a', customer: 'cus_a', status: 'trialing', metadata: { userId: 'u', planKey: 'player_pro' }, periodEnd: new Date('2026-11-01T00:00:00Z'), interval: 'year', amount: 4900 }) as never);
    expect(current).toMatchObject({ status: 'trialing', interval: 'year', currency: 'USD', amountMinor: 4900, currentPeriodEnd: new Date('2026-11-01T00:00:00Z'), metadata: { userId: 'u', planKey: 'player_pro' } });
    const legacy = { ...stripeSubscription({ id: 'sub_b', customer: 'cus_b', status: 'active', metadata: {} }), current_period_end: 1_800_000_000 } as Json;
    delete legacy.items.data[0].current_period_end;
    expect(normalizeSubscription(legacy as never).currentPeriodEnd).toEqual(new Date(1_800_000_000 * 1000));
    const portalCancel = { ...stripeSubscription({ id: 'sub_c', customer: 'cus_c', status: 'active', metadata: {} }), cancel_at: 1_800_000_000 };
    expect(normalizeSubscription(portalCancel as never).cancelAtPeriodEnd).toBe(true);
  });

  it('finds the subscription on failed invoices in both API shapes', () => {
    const base = { id: 'evt_1', object: 'event', created: 1_800_000_000, type: 'invoice.payment_failed' };
    const current = normalizeStripeEvent({ ...base, data: { object: { id: 'in_1', customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1' } } } } } as never);
    const legacy = normalizeStripeEvent({ ...base, data: { object: { id: 'in_2', customer: 'cus_1', parent: null, subscription: 'sub_2' } } } as never);
    expect(current).toMatchObject({ kind: 'invoice.payment_failed', subscriptionId: 'sub_1' });
    expect(legacy).toMatchObject({ kind: 'invoice.payment_failed', subscriptionId: 'sub_2' });
  });

  it('accepts only test-mode keys, and only with the webhook secret', () => {
    const base = {
      DATABASE_URL: 'postgres://x', AUTH_JWKS_URL: 'https://idp.test/jwks', AUTH_ISSUER: 'i', AUTH_AUDIENCE: 'a', S3_BUCKET_ORIGINALS: 'b',
      CDN_BASE_URL: 'https://cdn.test', DOB_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), VIEWER_HASH_SECRET: 'v'.repeat(32),
    };
    expect(loadConfig(base).STRIPE_SECRET_KEY).toBeUndefined();
    expect(loadConfig({ ...base, STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' }).STRIPE_SECRET_KEY).toBeUndefined();
    expect(loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc' }).STRIPE_SECRET_KEY).toBe('sk_test_abc');
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc' })).toThrow(/test-mode/);
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc' })).toThrow(/together/);
  });
});
