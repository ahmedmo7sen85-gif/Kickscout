/**
 * Product analytics storage: recording events (shared by the API's `track()` and the worker), the
 * daily rollup into `analytics_daily`, the North Star computation and raw-event retention.
 * What may be recorded is decided by the registry in @fp/contracts (`prepareEvent`).
 */
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@fp/db';
import { NORTH_STAR, prepareEvent } from '@fp/contracts';
import type { AnalyticsEventName, AnalyticsProps } from '@fp/contracts';

type Conn = Kysely<DB> | Transaction<DB>;

export interface EventSubject {
  /** The signed-in person the event is about (the actor). */
  userId?: string | null;
  /** Signed-out callers: a daily-rotating keyed hash (never a raw IP). */
  anonId?: string | null;
  /** Known already (saves a lookup); otherwise read from privacy_settings / age_records. */
  optedOut?: boolean;
  minor?: boolean;
}

/** The person's analytics preference and whether they are a minor. A missing age record counts as a minor. */
export async function analyticsSubject(db: Conn, userId: string): Promise<{ optedOut: boolean; minor: boolean }> {
  const row = await db.selectFrom('users')
    .leftJoin('privacy_settings', 'privacy_settings.user_id', 'users.id')
    .leftJoin('age_records', 'age_records.user_id', 'users.id')
    .select(['privacy_settings.allow_analytics', 'age_records.age_band'])
    .where('users.id', '=', userId)
    .executeTakeFirst();
  return { optedOut: row?.allow_analytics === false, minor: !row?.age_band || row.age_band !== 'adult' };
}

/**
 * Records one event if the registry allows it for this subject. Returns whether it was written.
 * Invalid or unknown events are dropped (and reported through `onDrop`), never thrown: analytics
 * must not break the action it describes.
 */
export async function recordEvent(
  db: Conn,
  name: string,
  properties: unknown,
  subject: EventSubject,
  opts: { source?: 'server' | 'client'; onDrop?: (reason: string) => void } = {},
): Promise<boolean> {
  const source = opts.source ?? 'server';
  const userId = subject.userId ?? null;
  let { optedOut, minor } = subject;
  if (userId && (optedOut === undefined || minor === undefined)) {
    const s = await analyticsSubject(db, userId);
    optedOut ??= s.optedOut;
    minor ??= s.minor;
  }
  const decision = prepareEvent(name, properties, { source, optedOut: optedOut ?? false, minor: minor ?? false });
  if (!decision.record) {
    opts.onDrop?.(decision.reason);
    return false;
  }
  await db.insertInto('analytics_events').values({
    name, source, user_id: userId, anon_id: userId ? null : (subject.anonId ?? null), properties: JSON.stringify(decision.properties),
  }).execute();
  return true;
}

/** Typed form for server code: the compiler checks the event name and its properties. */
export function recordServerEvent<N extends AnalyticsEventName>(db: Conn, name: N, properties: AnalyticsProps<N>, subject: EventSubject) {
  return recordEvent(db, name, properties, subject, { source: 'server' });
}

// ---------------------------------------------------------------- rollup

export interface RollupOptions {
  /** Days before yesterday that are rolled up when they have never been (first run, or after an outage). */
  backfillDays: number;
  /** Raw events older than this are deleted, once their day is rolled up. */
  retentionDays: number;
}
export const DEFAULT_ROLLUP: RollupOptions = { backfillDays: 35, retentionDays: 180 };

export interface RollupReport {
  daysRolled: number;
  eventsDeleted: number;
  /** New qualified talent discoveries counted by this run. */
  discoveries: number;
}

const DAY_MS = 86_400_000;
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const dayStart = (day: string) => new Date(`${day}T00:00:00.000Z`);
const addDays = (day: string, n: number) => utcDay(new Date(dayStart(day).getTime() + n * DAY_MS));

/** Stages at or after Shortlisted that count as a discovery (Archived does not). */
export const QUALIFYING_STAGES = ['shortlisted', 'monitoring', 'contact_requested', 'contacted', 'evaluation'] as const;

/**
 * Counts the North Star for one UTC day (see NORTH_STAR.definition) and stores each counted pair in
 * qualified_discoveries. Days must be computed in ascending order; recomputing a day replaces it.
 */
export async function computeNorthStar(tx: Transaction<DB>, day: string): Promise<number> {
  const start = dayStart(day);
  const end = dayStart(addDays(day, 1));
  const windowStart = addDays(day, -(NORTH_STAR.windowDays - 1));
  await tx.deleteFrom('qualified_discoveries').where('day', '=', sql<Date>`${day}::date`).execute();
  const stages = sql.join(QUALIFYING_STAGES.map((s) => sql`${s}`));
  const result = await sql`
    INSERT INTO qualified_discoveries (discoverer_kind, discoverer_id, player_id, day, source)
    SELECT DISTINCT ON (a.kind, a.discoverer, a.player_id) a.kind, a.discoverer, a.player_id, ${day}::date, a.source
    FROM (
      SELECT 'scout'::text AS kind, s.owner_id AS discoverer, sp.player_id, 'shortlist'::text AS source, sp.added_at AS at
      FROM shortlist_players sp JOIN shortlists s ON s.id = sp.shortlist_id
      WHERE sp.added_at >= ${start} AND sp.added_at < ${end}
      UNION ALL
      SELECT CASE WHEN o.id IS NOT NULL THEN 'organization' ELSE 'scout' END,
             CASE WHEN o.id IS NOT NULL THEN o.id ELSE coalesce(e.owner_user_id, h.changed_by) END,
             e.player_id, 'pipeline', h.created_at
      FROM crm_stage_history h JOIN crm_entries e ON e.id = h.entry_id
      LEFT JOIN organizations o ON o.id = e.organization_id AND o.verified_at IS NOT NULL AND o.status = 'active'
      WHERE h.created_at >= ${start} AND h.created_at < ${end} AND h.to_stage IN (${stages})
      UNION ALL
      SELECT CASE WHEN o.id IS NOT NULL THEN 'organization' ELSE 'scout' END,
             CASE WHEN o.id IS NOT NULL THEN o.id ELSE cr.scout_id END,
             cr.player_id, 'contact_request', cr.created_at
      FROM contact_requests cr
      LEFT JOIN organizations o ON o.id = cr.organization_id AND o.verified_at IS NOT NULL AND o.status = 'active'
      WHERE cr.created_at >= ${start} AND cr.created_at < ${end}
    ) a
    WHERE a.discoverer IS NOT NULL AND a.discoverer <> a.player_id
      AND (a.kind = 'organization' OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = a.discoverer AND r.role = 'scout'))
      AND EXISTS (SELECT 1 FROM user_roles r JOIN users u ON u.id = r.user_id WHERE r.user_id = a.player_id AND r.role = 'player' AND u.status = 'active')
      AND NOT EXISTS (
        SELECT 1 FROM qualified_discoveries q
        WHERE q.discoverer_kind = a.kind AND q.discoverer_id = a.discoverer AND q.player_id = a.player_id
          AND q.day >= ${windowStart}::date AND q.day < ${day}::date
      )
    ORDER BY a.kind, a.discoverer, a.player_id, a.at
  `.execute(tx);
  return Number(result.numAffectedRows ?? 0n);
}

/** Rolls one complete UTC day of raw events (and the North Star) into analytics_daily. Idempotent. */
export async function rollupDay(db: Kysely<DB>, day: string): Promise<number> {
  const start = dayStart(day);
  const end = dayStart(addDays(day, 1));
  const weekStart = dayStart(addDays(day, -6));
  return db.transaction().execute(async (tx) => {
    await tx.deleteFrom('analytics_daily').where('day', '=', sql<Date>`${day}::date`).execute();
    await sql`
      INSERT INTO analytics_daily (day, metric, dimension, value)
      SELECT ${day}::date, 'event:' || name, '', count(*) FROM analytics_events
      WHERE created_at >= ${start} AND created_at < ${end} GROUP BY name
      UNION ALL
      SELECT ${day}::date, 'users:' || name, '', count(DISTINCT user_id) FROM analytics_events
      WHERE created_at >= ${start} AND created_at < ${end} AND user_id IS NOT NULL GROUP BY name
      UNION ALL
      SELECT ${day}::date, 'dau', '', count(DISTINCT user_id) FROM analytics_events
      WHERE created_at >= ${start} AND created_at < ${end}
      UNION ALL
      SELECT ${day}::date, 'wau', '', count(DISTINCT user_id) FROM analytics_events
      WHERE created_at >= ${weekStart} AND created_at < ${end}
    `.execute(tx);
    const discoveries = await computeNorthStar(tx, day);
    await tx.insertInto('analytics_daily').values([
      { day, metric: 'north_star', dimension: '', value: discoveries },
      { day, metric: '_rolled', dimension: '', value: 1 },
    ]).execute();
    return discoveries;
  });
}

/**
 * Daily job (run from maintenance): rolls up every complete day that has not been rolled up yet
 * (the last `backfillDays`, plus any older day that still has raw events), oldest first, then
 * deletes raw events past retention whose day is rolled up. Cheap once a day is done: later runs
 * the same day only check the markers.
 */
export async function rollupAnalytics(db: Kysely<DB>, now: Date = new Date(), opts: RollupOptions = DEFAULT_ROLLUP): Promise<RollupReport> {
  const today = utcDay(now);
  const yesterday = addDays(today, -1);
  const candidates = new Set<string>();
  for (let i = opts.backfillDays - 1; i >= 0; i--) candidates.add(addDays(yesterday, -i));
  const older = await sql<{ day: string }>`
    SELECT DISTINCT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day FROM analytics_events
    WHERE created_at < ${dayStart(addDays(yesterday, -(opts.backfillDays - 1)))}`.execute(db);
  for (const r of older.rows) candidates.add(r.day);

  const rolled = new Set((await sql<{ day: string }>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day FROM analytics_daily WHERE metric = '_rolled'`.execute(db)).rows.map((r) => r.day));
  const days = [...candidates].filter((d) => !rolled.has(d)).sort();

  const report: RollupReport = { daysRolled: 0, eventsDeleted: 0, discoveries: 0 };
  for (const day of days) {
    report.discoveries += await rollupDay(db, day);
    report.daysRolled++;
  }

  const cutoff = new Date(now.getTime() - opts.retentionDays * DAY_MS);
  const deleted = await sql`
    DELETE FROM analytics_events e WHERE e.created_at < ${cutoff}
      AND EXISTS (SELECT 1 FROM analytics_daily d WHERE d.metric = '_rolled' AND d.day = (e.created_at AT TIME ZONE 'UTC')::date)`.execute(db);
  report.eventsDeleted = Number(deleted.numAffectedRows ?? 0n);
  // Counted pairs are only needed for the 30-day window; the daily totals stay in analytics_daily.
  await db.deleteFrom('qualified_discoveries').where('day', '<', sql<Date>`${utcDay(cutoff)}::date`).execute();
  return report;
}
