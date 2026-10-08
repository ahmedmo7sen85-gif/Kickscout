/**
 * Entitlements: what a user's plans let them do. This is the one place that turns plans into
 * FEATURE_* flags and numeric limits; the API asks it instead of hard-coding limits.
 *
 * Plans and their limits live in the database (table `plans`). A user always has the free plan of
 * each audience they belong to, plus every paid plan with a subscription that currently grants
 * access. When several plans apply, the most generous value of each limit wins.
 */
import type { Role } from './policy.js';

/** Known feature flags. `live` features are enforced today; the rest are announced as coming soon. */
export const FEATURES = {
  FEATURE_EXTENDED_UPLOADS: 'live',
  FEATURE_UNLIMITED_SCOUT_SEARCH: 'live',
  FEATURE_UNLIMITED_SHORTLISTS: 'live',
  FEATURE_PRO_ANALYTICS: 'coming_soon',
  FEATURE_TEAM_SEATS: 'coming_soon',
  FEATURE_PRIORITY_SUPPORT: 'coming_soon',
  FEATURE_API_ACCESS: 'coming_soon',
} as const satisfies Record<string, 'live' | 'coming_soon'>;
export type Feature = keyof typeof FEATURES;
export const isFeature = (s: string): s is Feature => Object.hasOwn(FEATURES, s);

export interface Limits {
  /** Longest clip, after trimming. */
  maxVideoSeconds: number;
  /** Videos kept at once (anything not deleted, rejected or failed). */
  maxActiveVideos: number;
  maxUploadsPerDay: number;
  /** Scout searches per calendar month (UTC); null is unlimited. */
  scoutSearchesPerMonth: number | null;
  /** Players kept across all of a scout's shortlists; null is unlimited. */
  shortlistSlots: number | null;
  /** People who can use an organisation plan. */
  seats: number;
}
export const LIMIT_KEYS = ['maxVideoSeconds', 'maxActiveVideos', 'maxUploadsPerDay', 'scoutSearchesPerMonth', 'shortlistSlots', 'seats'] as const;
const UNLIMITABLE: ReadonlySet<keyof Limits> = new Set(['scoutSearchesPerMonth', 'shortlistSlots']);

export type PlanAudience = 'player' | 'scout' | 'organization';
export type SubscriptionStatus = 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';

/** A plan as configured in the database. `limits` may leave keys out (use the default) or set null (unlimited, where allowed). */
export interface PlanDefinition {
  key: string;
  audience: PlanAudience;
  tier: 'free' | 'pro' | 'organization' | 'club' | 'enterprise';
  features: readonly string[];
  limits: Partial<Record<keyof Limits, number | null>>;
}

export interface SubscriptionGrant {
  planKey: string;
  status: SubscriptionStatus;
  /** End of the paid or trial period; null when the provider did not say. */
  currentPeriodEnd: Date | null;
}

export interface Entitlements {
  /** Plans in effect, free ones included, most generous last. */
  plans: string[];
  features: Feature[];
  limits: Limits;
}

/**
 * Defaults for anything a plan leaves unset: the API's configured free-plan upload limits, and no
 * scout quota (scout tools need the scout role and the Scout Free plan anyway).
 */
export function defaultLimits(upload: Pick<Limits, 'maxVideoSeconds' | 'maxActiveVideos' | 'maxUploadsPerDay'>): Limits {
  return { ...upload, scoutSearchesPerMonth: 0, shortlistSlots: 0, seats: 1 };
}

/** Statuses that still grant the plan. past_due keeps access while the provider retries the payment. */
const GRANTING: ReadonlySet<SubscriptionStatus> = new Set(['trialing', 'active', 'past_due']);

export function subscriptionGrants(sub: SubscriptionGrant, now: Date): boolean {
  if (!GRANTING.has(sub.status)) return false;
  return sub.currentPeriodEnd === null || sub.currentPeriodEnd.getTime() > now.getTime();
}

/** The free plans every user gets from their roles. */
export function basePlanKeys(roles: readonly Role[]): string[] {
  const keys = ['player_free'];
  if (roles.includes('scout')) keys.push('scout_free');
  return keys;
}

/** Whether a role set may buy a plan for this audience. Scout tools are for verified scouts only. */
export function audienceAllowed(audience: PlanAudience, roles: readonly Role[]): { allowed: true } | { allowed: false; code: string } {
  if (audience === 'player') return roles.includes('player') ? { allowed: true } : { allowed: false, code: 'ROLE_REQUIRED' };
  return roles.includes('scout') ? { allowed: true } : { allowed: false, code: 'SCOUT_VERIFICATION_REQUIRED' };
}

function plannedValue(key: keyof Limits, raw: number | null | undefined, fallback: number | null): number | null {
  if (raw === undefined) return fallback;
  if (raw === null) return UNLIMITABLE.has(key) ? null : fallback;
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/** null (unlimited) beats any number; otherwise the larger number wins. */
function moreGenerous(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return Math.max(a, b);
}

/** Effective limits of one plan on top of the defaults. */
export function planLimits(plan: PlanDefinition, defaults: Limits): Limits {
  const out: Record<string, number | null> = { ...defaults };
  for (const k of LIMIT_KEYS) out[k] = plannedValue(k, plan.limits[k], defaults[k]);
  return out as unknown as Limits;
}

function mergeLimits(a: Limits, b: Limits): Limits {
  const out: Record<string, number | null> = { ...a };
  for (const k of LIMIT_KEYS) out[k] = moreGenerous(a[k], b[k]);
  return out as unknown as Limits;
}

export function resolveEntitlements(input: {
  roles: readonly Role[];
  /** Every plan the user might hold, keyed by plan key (unknown keys are skipped). */
  plans: ReadonlyMap<string, PlanDefinition>;
  subscriptions: readonly SubscriptionGrant[];
  defaults: Limits;
  now: Date;
}): Entitlements {
  const keys = basePlanKeys(input.roles);
  for (const s of input.subscriptions) if (subscriptionGrants(s, input.now) && !keys.includes(s.planKey)) keys.push(s.planKey);
  const held = keys.flatMap((k) => (input.plans.has(k) ? [input.plans.get(k)!] : []));

  let limits: Limits | null = null;
  const features = new Set<Feature>();
  for (const plan of held) {
    const l = planLimits(plan, input.defaults);
    limits = limits ? mergeLimits(limits, l) : l;
    for (const f of plan.features) if (isFeature(f)) features.add(f);
  }
  limits ??= { ...input.defaults };

  // Staff are never metered on scout tools.
  if (input.roles.includes('admin')) {
    limits.scoutSearchesPerMonth = null;
    limits.shortlistSlots = null;
  }
  return { plans: held.map((p) => p.key), features: [...features].sort(), limits };
}

/** 'YYYY-MM' in UTC, the period for monthly quotas. */
export function monthPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** First instant of the next UTC month, when a monthly quota resets. */
export function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
