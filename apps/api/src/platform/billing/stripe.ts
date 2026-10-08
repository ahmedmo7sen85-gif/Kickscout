import Stripe from 'stripe';
import type { BillingEvent, BillingMetadata, CreateCheckoutInput, PaymentProvider, ProviderSubscription, SubscriptionStatus } from './provider.js';
import { WebhookSignatureError } from './provider.js';

const STATUSES: ReadonlySet<string> = new Set(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']);

const date = (unix: number | null | undefined) => (typeof unix === 'number' ? new Date(unix * 1000) : null);
const idOf = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : v?.id ?? null);

function metadataOf(m: Record<string, string> | null | undefined): Partial<BillingMetadata> {
  const out: Partial<BillingMetadata> = {};
  if (m?.userId) out.userId = m.userId;
  if (m?.payerUserId) out.payerUserId = m.payerUserId;
  if (m?.planKey) out.planKey = m.planKey;
  if (m?.couponCode) out.couponCode = m.couponCode;
  return out;
}

/** Stripe subscription → provider-neutral shape. Handles both item-level and (older) top-level period fields. */
export function normalizeSubscription(sub: Stripe.Subscription): ProviderSubscription {
  const item = sub.items?.data?.[0];
  const legacy = sub as unknown as { current_period_end?: number };
  const status = STATUSES.has(sub.status) ? (sub.status as SubscriptionStatus) : 'incomplete';
  const interval: string | undefined = item?.price?.recurring?.interval;
  return {
    id: sub.id,
    customerId: idOf(sub.customer as string | { id: string } | null),
    status,
    interval: interval === 'month' || interval === 'year' ? interval : null,
    currency: item?.price?.currency ? item.price.currency.toUpperCase() : sub.currency ? sub.currency.toUpperCase() : null,
    amountMinor: item?.price?.unit_amount ?? null,
    trialEnd: date(sub.trial_end),
    currentPeriodEnd: date(item?.current_period_end ?? legacy.current_period_end),
    // Cancelling in the portal sets cancel_at_period_end, or cancel_at on newer API versions.
    cancelAtPeriodEnd: sub.cancel_at_period_end || sub.cancel_at != null,
    canceledAt: date(sub.canceled_at),
    metadata: metadataOf(sub.metadata),
  };
}

/** Stripe event → BillingEvent. Event types we do not act on come back as `ignored`. */
export function normalizeStripeEvent(event: Stripe.Event): BillingEvent {
  const base = { id: event.id, type: event.type, createdAt: new Date(event.created * 1000) };
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      return {
        ...base, kind: 'checkout.completed', sessionId: s.id,
        customerId: idOf(s.customer as string | { id: string } | null), subscriptionId: idOf(s.subscription as string | { id: string } | null),
        metadata: metadataOf(s.metadata),
      };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return { ...base, kind: 'subscription', subscription: normalizeSubscription(event.data.object) };
    case 'invoice.payment_failed': {
      const inv = event.data.object;
      const legacy = inv as unknown as { subscription?: string | { id: string } | null };
      const fromParent = inv.parent?.subscription_details?.subscription as string | { id: string } | null | undefined;
      return { ...base, kind: 'invoice.payment_failed', subscriptionId: idOf(fromParent ?? legacy.subscription), customerId: idOf(inv.customer as string | { id: string } | null) };
    }
    default:
      return { ...base, kind: 'ignored' };
  }
}

/** Verifies a Stripe-Signature header over the raw body (offline, no API call) and normalises the event. */
export function parseStripeWebhook(rawBody: Buffer, signature: string | undefined, webhookSecret: string): BillingEvent {
  if (!signature) throw new WebhookSignatureError('missing signature');
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    throw new WebhookSignatureError((err as Error).message);
  }
  return normalizeStripeEvent(event);
}

/** Stripe Checkout and Billing Portal. Test-mode keys only (enforced in config). */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly signatureHeader = 'stripe-signature';
  private readonly stripe: Stripe;

  constructor(secretKey: string, private readonly webhookSecret: string) {
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 15_000 });
  }

  async createCheckoutSession(input: CreateCheckoutInput) {
    const { line } = input;
    const metadata: Record<string, string> = { userId: input.metadata.userId, payerUserId: input.metadata.payerUserId, planKey: input.metadata.planKey };
    if (input.metadata.couponCode) metadata.couponCode = input.metadata.couponCode;
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        line.providerPriceId
          ? { price: line.providerPriceId, quantity: 1 }
          : {
              quantity: 1,
              price_data: {
                currency: line.currency.toLowerCase(),
                unit_amount: line.amountMinor,
                recurring: { interval: line.interval },
                product_data: { name: line.productName },
              },
            },
      ],
      ...(input.customerId ? { customer: input.customerId } : input.customerEmail ? { customer_email: input.customerEmail } : {}),
      client_reference_id: input.metadata.payerUserId,
      metadata,
      subscription_data: { metadata, ...(input.trialDays > 0 ? { trial_period_days: input.trialDays } : {}) },
      // A code we validated is applied directly; otherwise the hosted page offers a code field. Stripe allows only one of the two.
      ...(input.promotionCodeId ? { discounts: [{ promotion_code: input.promotionCodeId }] } : { allow_promotion_codes: true }),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error('Stripe returned a checkout session without a URL');
    return { id: session.id, url: session.url };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }) {
    const s = await this.stripe.billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl });
    return { url: s.url };
  }

  async cancelSubscription(providerSubscriptionId: string) {
    try {
      await this.stripe.subscriptions.cancel(providerSubscriptionId);
    } catch (err) {
      // Already cancelled or deleted at Stripe: nothing left to stop.
      if ((err as { code?: string }).code === 'resource_missing') return;
      throw err;
    }
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): BillingEvent {
    return parseStripeWebhook(rawBody, signature, this.webhookSecret);
  }
}
