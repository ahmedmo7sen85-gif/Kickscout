/**
 * Pure helpers for plans and prices. Every number shown comes from the API (`GET /v1/plans`),
 * which reads it from the database; nothing here hard-codes a price.
 */
import { fmt, type Dict } from './i18n';
import type { BillingInterval, PlanLimits, PlanPrice, PlanView } from './types';

/** Formats minor units (cents) in the plan's currency, without trailing .00 on whole amounts. */
export function formatPrice(amountMinor: number, currency: string, locale: string): string {
  const probe = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const digits = probe.resolvedOptions().maximumFractionDigits ?? 2;
  const amount = amountMinor / 10 ** digits;
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: whole ? 0 : digits, maximumFractionDigits: digits }).format(amount);
}

/** The price for the chosen interval, falling back to monthly when a plan is sold monthly only. */
export function priceFor(plan: PlanView, interval: BillingInterval): { price: PlanPrice; fallback: boolean } | null {
  const exact = plan.prices.find((p) => p.interval === interval);
  if (exact) return { price: exact, fallback: false };
  const monthly = plan.prices.find((p) => p.interval === 'month');
  return monthly ? { price: monthly, fallback: true } : null;
}

/** Whole-percent saving of yearly over twelve monthly payments, or null when there is none to show. */
export function yearlySavingPct(plan: PlanView): number | null {
  const m = plan.prices.find((p) => p.interval === 'month');
  const y = plan.prices.find((p) => p.interval === 'year');
  if (!m || !y || m.currency !== y.currency) return null;
  const pct = Math.floor((1 - y.amountMinor / (m.amountMinor * 12)) * 100);
  return pct > 0 ? pct : null;
}

/** When a trial started now would end; shown so nobody is surprised by the first charge. */
export function trialEndDate(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

/** The plan's enforced limits as plain sentences, only the ones relevant to its audience. */
export function limitLines(plan: Pick<PlanView, 'audience'> & { limits: PlanLimits }, t: Dict): string[] {
  const b = t.billing;
  const l = plan.limits;
  if (plan.audience === 'player') {
    return [fmt(b.limitClip, { n: l.maxVideoSeconds }), fmt(b.limitActive, { n: l.maxActiveVideos }), fmt(b.limitDaily, { n: l.maxUploadsPerDay })];
  }
  const lines = [
    l.scoutSearchesPerMonth === null ? b.limitSearchesUnlimited : fmt(b.limitSearches, { n: l.scoutSearchesPerMonth }),
    l.shortlistSlots === null ? b.limitSlotsUnlimited : fmt(b.limitSlots, { n: l.shortlistSlots }),
  ];
  if (l.seats > 1) lines.push(fmt(b.limitSeats, { n: l.seats }));
  return lines;
}

export const featureLabel = (key: string, t: Dict): string => (t.billing.features as Record<string, string>)[key] ?? key;
