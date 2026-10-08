import Stripe from 'stripe';
import type { BillingEvent, CreateCheckoutInput, PaymentProvider } from '../src/platform/billing/provider.js';
import { parseStripeWebhook } from '../src/platform/billing/stripe.js';

export const FAKE_WEBHOOK_SECRET = 'whsec_fake_test_secret_for_kickscout';

/**
 * Payment provider for tests: no network. Checkout and portal calls are recorded and return
 * test URLs; webhooks are real Stripe-format events, signed and verified exactly as Stripe's are,
 * so the production parsing code runs. Nothing here simulates a successful payment by itself:
 * a test must send the subscription events, as Stripe would.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly signatureHeader = 'stripe-signature';
  readonly checkouts: (CreateCheckoutInput & { id: string })[] = [];
  readonly portals: { customerId: string; returnUrl: string }[] = [];
  private n = 0;

  async createCheckoutSession(input: CreateCheckoutInput) {
    const id = `cs_test_fake_${++this.n}`;
    this.checkouts.push({ ...input, id });
    return { id, url: `https://checkout.fake.test/c/pay/${id}` };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }) {
    this.portals.push(input);
    return { url: `https://billing.fake.test/p/session/${input.customerId}` };
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): BillingEvent {
    return parseStripeWebhook(rawBody, signature, FAKE_WEBHOOK_SECRET);
  }
}

let seq = 0;
/** A Stripe-shaped event payload plus a valid Stripe-Signature header for it. */
export function signedStripeEvent(type: string, object: Record<string, unknown>, opts: { id?: string; created?: number; secret?: string } = {}) {
  const event = {
    id: opts.id ?? `evt_test_${Date.now()}_${++seq}`,
    object: 'event',
    api_version: Stripe.API_VERSION,
    created: opts.created ?? Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? FAKE_WEBHOOK_SECRET });
  return { event, payload, signature };
}

/** A Stripe subscription object as the current API version sends it (period dates on the item). */
export function stripeSubscription(o: {
  id: string; customer: string; status: string; metadata: Record<string, string>; interval?: 'month' | 'year'; amount?: number;
  trialEnd?: Date | null; periodEnd?: Date; cancelAtPeriodEnd?: boolean; canceledAt?: Date | null;
}) {
  const unix = (d: Date | null | undefined) => (d ? Math.floor(d.getTime() / 1000) : null);
  return {
    id: o.id, object: 'subscription', customer: o.customer, status: o.status, metadata: o.metadata, currency: 'usd',
    trial_end: unix(o.trialEnd ?? null), cancel_at_period_end: o.cancelAtPeriodEnd ?? false, cancel_at: null, canceled_at: unix(o.canceledAt ?? null),
    items: {
      object: 'list',
      data: [{
        id: `si_${o.id}`, object: 'subscription_item', quantity: 1,
        current_period_end: unix(o.periodEnd ?? new Date(Date.now() + 30 * 86_400_000)),
        price: { id: 'price_inline', object: 'price', currency: 'usd', unit_amount: o.amount ?? 499, recurring: { interval: o.interval ?? 'month' } },
      }],
    },
  };
}
