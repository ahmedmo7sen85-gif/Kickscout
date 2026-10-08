/**
 * Payment provider boundary. The API talks to payments only through this interface, so the
 * provider can be swapped (or faked in tests) without touching billing rules.
 *
 * Nothing here grants anything: checkout only returns a hosted payment page, and entitlements
 * change only when a verified webhook event updates the `subscriptions` table.
 */

export type BillingInterval = 'month' | 'year';

/** Written on the checkout session and the subscription, so every webhook can be attributed. */
export interface BillingMetadata {
  /** Who the plan is for. */
  userId: string;
  /** Who pays (the guardian, for a minor). */
  payerUserId: string;
  planKey: string;
  couponCode?: string;
}

export interface CheckoutLine {
  productName: string;
  /** ISO 4217, upper case. */
  currency: string;
  /** Minor units (cents for USD). */
  amountMinor: number;
  interval: BillingInterval;
  /** A catalogue price at the provider; when null the amount above is sent inline. */
  providerPriceId: string | null;
}

export interface CreateCheckoutInput {
  line: CheckoutLine;
  customerId: string | null;
  customerEmail: string | null;
  /** 0 for no trial. */
  trialDays: number;
  /** A provider promotion code to apply. When null, the hosted page lets people enter one themselves. */
  promotionCodeId: string | null;
  successUrl: string;
  cancelUrl: string;
  metadata: BillingMetadata;
}

export type SubscriptionStatus = 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';

export interface ProviderSubscription {
  id: string;
  customerId: string | null;
  status: SubscriptionStatus;
  interval: BillingInterval | null;
  currency: string | null;
  amountMinor: number | null;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  metadata: Partial<BillingMetadata>;
}

interface EventBase {
  /** Provider event id; the idempotency key. */
  id: string;
  /** Provider event type, e.g. customer.subscription.updated. */
  type: string;
  createdAt: Date;
}

export type BillingEvent =
  | (EventBase & { kind: 'checkout.completed'; sessionId: string; customerId: string | null; subscriptionId: string | null; metadata: Partial<BillingMetadata> })
  | (EventBase & { kind: 'subscription'; subscription: ProviderSubscription })
  | (EventBase & { kind: 'invoice.payment_failed'; subscriptionId: string | null; customerId: string | null })
  | (EventBase & { kind: 'ignored' });

export class WebhookSignatureError extends Error {}

export interface PaymentProvider {
  /** Stored with every provider record ('stripe'). */
  readonly name: string;
  /** Request header carrying the webhook signature. */
  readonly signatureHeader: string;
  createCheckoutSession(input: CreateCheckoutInput): Promise<{ id: string; url: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Verifies the signature over the exact raw body and normalises the event; throws WebhookSignatureError. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): BillingEvent;
}
