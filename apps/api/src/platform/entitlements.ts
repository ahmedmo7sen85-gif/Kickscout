import { sql } from 'kysely';
import { defaultLimits, monthPeriod, resolveEntitlements } from '@fp/domain';
import type { Entitlements, Limits, PlanDefinition, Role, SubscriptionStatus } from '@fp/domain';
import type { Database } from '@fp/db';
import type { Deps } from '../deps.js';
import { ApiError } from './errors.js';

/** Defaults for anything a plan leaves unset: the configured free-plan upload limits. */
export function configuredDefaults(config: Deps['config']): Limits {
  return defaultLimits({ maxVideoSeconds: config.MAX_VIDEO_SECONDS, maxActiveVideos: config.MAX_ACTIVE_VIDEOS, maxUploadsPerDay: config.MAX_UPLOADS_PER_DAY });
}

export type PlanRow = Awaited<ReturnType<typeof planRows>>[number];

export function planRows(db: Database) {
  return db.selectFrom('plans').selectAll().orderBy('sort_order').orderBy('key').execute();
}

export function toPlanDefinition(r: PlanRow): PlanDefinition {
  return {
    key: r.key,
    audience: r.audience as PlanDefinition['audience'],
    tier: r.tier as PlanDefinition['tier'],
    features: r.features,
    limits: (r.limits ?? {}) as PlanDefinition['limits'],
  };
}

/** Every plan a user might hold, inactive ones included (people keep a plan that is no longer sold). */
export async function planDefinitions(db: Database): Promise<Map<string, PlanDefinition>> {
  return new Map((await planRows(db)).map((r) => [r.key, toPlanDefinition(r)]));
}

/**
 * The user's effective plan, features and limits. Subscriptions written by verified webhooks are
 * the only source of paid entitlements.
 */
export async function entitlementsFor(deps: Deps, userId: string, roles: readonly Role[]): Promise<Entitlements> {
  const [plans, subs] = await Promise.all([
    planDefinitions(deps.db),
    deps.db.selectFrom('subscriptions').select(['plan_key', 'status', 'current_period_end']).where('user_id', '=', userId).execute(),
  ]);
  return resolveEntitlements({
    roles,
    plans,
    subscriptions: subs.map((s) => ({ planKey: s.plan_key, status: s.status as SubscriptionStatus, currentPeriodEnd: s.current_period_end })),
    defaults: configuredDefaults(deps.config),
    now: deps.now(),
  });
}

export const SCOUT_SEARCH_METRIC = 'scout.search';

/**
 * Counts one scout search against the monthly quota, atomically: the counter only moves while it
 * is under the limit, so concurrent searches cannot overshoot. Unlimited plans are still counted.
 */
export async function consumeScoutSearch(deps: Deps, userId: string, limits: Limits): Promise<void> {
  const limit = limits.scoutSearchesPerMonth;
  const quotaError = () => new ApiError(429, 'QUOTA_SCOUT_SEARCHES',
    `your plan includes ${limit} scout searches per month; upgrade for unlimited search or wait until next month`);
  if (limit !== null && limit <= 0) throw quotaError();
  const row = await deps.db.insertInto('usage_counters')
    .values({ user_id: userId, metric: SCOUT_SEARCH_METRIC, period: monthPeriod(deps.now()), count: 1 })
    .onConflict((oc) => {
      const upd = oc.columns(['user_id', 'metric', 'period']).doUpdateSet({ count: sql`usage_counters.count + 1` });
      return limit === null ? upd : upd.where('usage_counters.count', '<', limit);
    })
    .returning('count')
    .executeTakeFirst();
  if (!row) throw quotaError();
}

export async function scoutSearchesUsed(db: Database, userId: string, now: Date): Promise<number> {
  const r = await db.selectFrom('usage_counters').select('count').where('user_id', '=', userId).where('metric', '=', SCOUT_SEARCH_METRIC)
    .where('period', '=', monthPeriod(now)).executeTakeFirst();
  return r?.count ?? 0;
}

/** Distinct players across all of a scout's shortlists (one player on two lists uses one slot). */
export async function shortlistSlotsUsed(db: Database, ownerId: string, playerId?: string): Promise<{ used: number; alreadyListed: boolean }> {
  const r = await db.selectFrom('shortlist_players').innerJoin('shortlists', 'shortlists.id', 'shortlist_players.shortlist_id')
    .select([
      sql<number>`count(distinct shortlist_players.player_id)::int`.as('used'),
      sql<boolean>`coalesce(bool_or(shortlist_players.player_id = ${playerId ?? null}::uuid), false)`.as('listed'),
    ])
    .where('shortlists.owner_id', '=', ownerId).executeTakeFirstOrThrow();
  return { used: r.used, alreadyListed: r.listed };
}

export async function uploadUsage(deps: Deps, userId: string): Promise<{ active: number; today: number }> {
  const since = new Date(deps.now().getTime() - 24 * 60 * 60 * 1000);
  return deps.db
    .selectFrom('videos')
    .select([
      sql<number>`count(*) filter (where status not in ('deleted', 'rejected', 'failed'))::int`.as('active'),
      sql<number>`count(*) filter (where created_at >= ${since})::int`.as('today'),
    ])
    .where('owner_user_id', '=', userId)
    .executeTakeFirstOrThrow();
}
