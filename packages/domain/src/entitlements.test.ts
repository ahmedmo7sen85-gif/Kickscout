import { describe, expect, it } from 'vitest';
import { audienceAllowed, defaultLimits, monthPeriod, nextMonthStart, planLimits, resolveEntitlements, subscriptionGrants } from './entitlements.js';
import type { PlanDefinition, SubscriptionGrant } from './entitlements.js';
import { can } from './policy.js';
import type { Actor, ConsentPurpose } from './policy.js';

// Mirrors the seeded rows in db/migrations/0006_billing.sql.
const PLANS = new Map<string, PlanDefinition>([
  ['player_free', { key: 'player_free', audience: 'player', tier: 'free', features: [], limits: {} }],
  ['player_pro', { key: 'player_pro', audience: 'player', tier: 'pro', features: ['FEATURE_EXTENDED_UPLOADS', 'FEATURE_PRO_ANALYTICS'], limits: { maxVideoSeconds: 180, maxActiveVideos: 100, maxUploadsPerDay: 30 } }],
  ['scout_free', { key: 'scout_free', audience: 'scout', tier: 'free', features: [], limits: { scoutSearchesPerMonth: 20, shortlistSlots: 10, seats: 1 } }],
  ['scout_pro', { key: 'scout_pro', audience: 'scout', tier: 'pro', features: ['FEATURE_UNLIMITED_SCOUT_SEARCH', 'FEATURE_UNLIMITED_SHORTLISTS', 'FEATURE_PRO_ANALYTICS'], limits: { scoutSearchesPerMonth: null, shortlistSlots: null, seats: 1 } }],
  ['organization', { key: 'organization', audience: 'organization', tier: 'organization', features: ['FEATURE_TEAM_SEATS', 'FEATURE_NOT_A_REAL_FLAG'], limits: { scoutSearchesPerMonth: null, shortlistSlots: null, seats: 5 } }],
]);
const NOW = new Date('2026-10-08T12:00:00Z');
const DEFAULTS = defaultLimits({ maxVideoSeconds: 60, maxActiveVideos: 20, maxUploadsPerDay: 10 });
const later = new Date('2026-11-08T12:00:00Z');
const sub = (planKey: string, status: SubscriptionGrant['status'] = 'active', currentPeriodEnd: Date | null = later): SubscriptionGrant => ({ planKey, status, currentPeriodEnd });
const resolve = (roles: Actor['roles'], subscriptions: SubscriptionGrant[] = []) => resolveEntitlements({ roles, plans: PLANS, subscriptions, defaults: DEFAULTS, now: NOW });

describe('resolveEntitlements', () => {
  it('gives a free player the configured free upload limits and no scout quota', () => {
    const e = resolve(['player']);
    expect(e.plans).toEqual(['player_free']);
    expect(e.features).toEqual([]);
    expect(e.limits).toEqual({ maxVideoSeconds: 60, maxActiveVideos: 20, maxUploadsPerDay: 10, scoutSearchesPerMonth: 0, shortlistSlots: 0, seats: 1 });
  });

  it('gives Player Pro 180 s clips and 100 active videos while trialing or active', () => {
    for (const status of ['trialing', 'active', 'past_due'] as const) {
      const e = resolve(['player'], [sub('player_pro', status)]);
      expect(e.plans).toEqual(['player_free', 'player_pro']);
      expect(e.limits).toMatchObject({ maxVideoSeconds: 180, maxActiveVideos: 100, maxUploadsPerDay: 30 });
      expect(e.features).toEqual(['FEATURE_EXTENDED_UPLOADS', 'FEATURE_PRO_ANALYTICS']);
    }
  });

  it('ignores subscriptions that are canceled, unpaid, incomplete or past their period', () => {
    for (const s of [sub('player_pro', 'canceled'), sub('player_pro', 'unpaid'), sub('player_pro', 'incomplete'), sub('player_pro', 'active', new Date('2026-10-01T00:00:00Z'))]) {
      expect(resolve(['player'], [s]).limits.maxVideoSeconds).toBe(60);
    }
    expect(subscriptionGrants(sub('player_pro', 'active', null), NOW)).toBe(true);
  });

  it('gives verified scouts the Scout Free quota, and unlimited search with Scout Pro', () => {
    expect(resolve(['fan', 'scout']).limits).toMatchObject({ scoutSearchesPerMonth: 20, shortlistSlots: 10 });
    const pro = resolve(['fan', 'scout'], [sub('scout_pro')]);
    expect(pro.limits).toMatchObject({ scoutSearchesPerMonth: null, shortlistSlots: null });
    expect(pro.features).toContain('FEATURE_UNLIMITED_SCOUT_SEARCH');
  });

  it('takes the most generous value of each limit across plans and drops unknown flags', () => {
    const e = resolve(['player', 'scout'], [sub('player_pro'), sub('organization')]);
    expect(e.limits).toEqual({ maxVideoSeconds: 180, maxActiveVideos: 100, maxUploadsPerDay: 30, scoutSearchesPerMonth: null, shortlistSlots: null, seats: 5 });
    expect(e.features).not.toContain('FEATURE_NOT_A_REAL_FLAG');
  });

  it('never lets a plan go below the configured free default, and never makes upload limits unlimited', () => {
    expect(planLimits({ key: 'x', audience: 'player', tier: 'pro', features: [], limits: { maxVideoSeconds: null, maxActiveVideos: -1 } }, DEFAULTS))
      .toMatchObject({ maxVideoSeconds: 60, maxActiveVideos: 20 });
    // A higher configured default (e.g. MAX_UPLOADS_PER_DAY=50) still beats a lower plan value.
    const e = resolveEntitlements({ roles: ['player'], plans: PLANS, subscriptions: [sub('player_pro')], defaults: { ...DEFAULTS, maxUploadsPerDay: 50 }, now: NOW });
    expect(e.limits.maxUploadsPerDay).toBe(50);
  });

  it('does not meter admins on scout tools', () => {
    expect(resolve(['admin']).limits).toMatchObject({ scoutSearchesPerMonth: null, shortlistSlots: null });
  });

  it('lets only players buy player plans and only verified scouts buy scout and organisation plans', () => {
    expect(audienceAllowed('player', ['player'])).toEqual({ allowed: true });
    expect(audienceAllowed('player', ['fan'])).toEqual({ allowed: false, code: 'ROLE_REQUIRED' });
    expect(audienceAllowed('scout', ['fan'])).toEqual({ allowed: false, code: 'SCOUT_VERIFICATION_REQUIRED' });
    expect(audienceAllowed('organization', ['fan', 'scout'])).toEqual({ allowed: true });
  });

  it('counts monthly quotas per UTC calendar month', () => {
    expect(monthPeriod(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(nextMonthStart(new Date('2026-12-15T00:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('billing.purchase policy', () => {
  const actor = (over: Partial<Actor> = {}): Actor => ({
    userId: 'a', roles: ['player'], status: 'active', ageBand: 'adult', mfa: false, guardianOf: [],
    consents: new Set<ConsentPurpose>(['account']), ...over,
  });

  it('lets an adult buy for themselves', () => {
    expect(can(actor(), { kind: 'billing.purchase', subjectId: 'a', subjectMinor: false }).allowed).toBe(true);
  });

  it('blocks a minor from buying, for themselves or anyone', () => {
    const minor = actor({ ageBand: 'u16' });
    expect(can(minor, { kind: 'billing.purchase', subjectId: 'a', subjectMinor: true })).toMatchObject({ allowed: false, code: 'GUARDIAN_REQUIRED' });
    expect(can(actor({ ageBand: 'u18', guardianOf: ['b'] }), { kind: 'billing.purchase', subjectId: 'b', subjectMinor: true }).allowed).toBe(false);
  });

  it('lets a guardian buy for their ward, and nobody else buy for another user', () => {
    expect(can(actor({ userId: 'g', guardianOf: ['m'] }), { kind: 'billing.purchase', subjectId: 'm', subjectMinor: true }).allowed).toBe(true);
    expect(can(actor({ userId: 'x' }), { kind: 'billing.purchase', subjectId: 'm', subjectMinor: true })).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('blocks accounts still waiting for guardian consent', () => {
    expect(can(actor({ status: 'pending_consent' }), { kind: 'billing.purchase', subjectId: 'a', subjectMinor: false })).toMatchObject({ code: 'CONSENT_REQUIRED' });
  });
});
