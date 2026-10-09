import { sql } from 'kysely';
import type { z } from 'zod';
import { AdminMetrics, AdminMetricsQuery, NORTH_STAR, prepareEvent, TrackEventsRequest, TrackEventsResponse } from '@fp/contracts';
import type { FunnelView } from '@fp/contracts';
import { analyticsSubject } from '@fp/worker/analytics';
import { route } from '../platform/route.js';
import { anonymousId, browserOptsOut } from '../platform/analytics.js';
import type { Deps } from '../deps.js';

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Daily series shown on the admin metrics page, by aggregate metric name. */
const SERIES = {
  dau: 'dau',
  wau: 'wau',
  uploads: 'event:upload_started',
  publishes: 'event:upload_published',
  scoutSearches: 'event:scout_search',
  contactRequests: 'event:contact_requested',
} as const;

/**
 * Each funnel counts signed-in users who did a step and every earlier step inside the window.
 * Steps are taken by the same person, so the scout funnel stops at the request (the player answers it).
 */
const FUNNELS: { key: z.infer<typeof FunnelView>['key']; steps: string[] }[] = [
  { key: 'player_activation', steps: ['signup_completed', 'upload_started', 'upload_published'] },
  { key: 'scout_discovery', steps: ['scout_search', 'shortlist_add', 'contact_requested'] },
  { key: 'checkout', steps: ['checkout_started', 'subscription_activated'] },
];

async function funnel(deps: Deps, steps: string[], from: Date) {
  const flags = steps.map((s, i) => sql`bool_or(name = ${s}) AS ${sql.ref(`s${i}`)}`);
  const counts = steps.map((_, i) => sql`count(*) FILTER (WHERE ${sql.join(steps.slice(0, i + 1).map((__, j) => sql.ref(`s${j}`)), sql` AND `)})::int AS ${sql.ref(`c${i}`)}`);
  const { rows } = await sql<Record<string, number>>`
    SELECT ${sql.join(counts)} FROM (
      SELECT user_id, ${sql.join(flags)} FROM analytics_events
      WHERE created_at >= ${from} AND user_id IS NOT NULL AND name IN (${sql.join(steps)})
      GROUP BY user_id
    ) t`.execute(deps.db);
  return steps.map((event, i) => ({ event, users: Number(rows[0]?.[`c${i}`] ?? 0) }));
}

export const analyticsRoutes = [
  route(
    {
      method: 'post', path: '/v1/events', summary: 'Record product-analytics events from the web app (allowlisted names only; batched)',
      tag: 'analytics', auth: 'optional', body: TrackEventsRequest, response: TrackEventsResponse, status: 202, rateLimit: { max: 30, timeWindow: '1 minute' },
    },
    async (ctx) => {
      const actor = ctx.actor;
      const subject = actor
        ? { userId: actor.userId, anonId: null, ...(await analyticsSubject(ctx.deps.db, actor.userId)) }
        : { userId: null, anonId: anonymousId(ctx.deps, ctx.req), optedOut: browserOptsOut(ctx.req), minor: false };
      const rows = [];
      for (const e of ctx.body.events) {
        const d = prepareEvent(e.name, e.properties, { source: 'client', optedOut: subject.optedOut, minor: subject.minor });
        if (d.record) rows.push({ name: e.name, source: 'client', user_id: subject.userId, anon_id: subject.anonId, properties: JSON.stringify(d.properties) });
      }
      if (rows.length) await ctx.deps.db.insertInto('analytics_events').values(rows).execute();
      return { accepted: rows.length, dropped: ctx.body.events.length - rows.length };
    },
  ),

  route(
    { method: 'get', path: '/v1/admin/metrics', summary: 'North Star, active users, uploads, searches, contact requests and funnels (admin, MFA)', tag: 'admin', auth: 'user', query: AdminMetricsQuery, response: AdminMetrics },
    async (ctx) => {
      ctx.authorize({ kind: 'admin.access' });
      const db = ctx.deps.db;
      const now = ctx.deps.now();
      // Series end yesterday: a day is rolled up once it is complete.
      const to = isoDay(new Date(now.getTime() - DAY_MS));
      const fromDate = new Date(Date.parse(`${to}T00:00:00Z`) - (ctx.query.days - 1) * DAY_MS);
      const from = isoDay(fromDate);
      const days = Array.from({ length: ctx.query.days }, (_, i) => isoDay(new Date(fromDate.getTime() + i * DAY_MS)));

      const metrics = ['north_star', ...Object.values(SERIES)];
      const [rows, last] = await Promise.all([
        db.selectFrom('analytics_daily').select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'), 'metric', 'value'])
          .where('dimension', '=', '').where('metric', 'in', metrics)
          .where('day', '>=', sql<Date>`${from}::date`).where('day', '<=', sql<Date>`${to}::date`).execute(),
        db.selectFrom('analytics_daily').select(sql<string | null>`to_char(max(day), 'YYYY-MM-DD')`.as('day')).where('metric', '=', '_rolled').executeTakeFirst(),
      ]);
      const byMetric = new Map<string, Map<string, number>>();
      for (const r of rows) {
        if (!byMetric.has(r.metric)) byMetric.set(r.metric, new Map());
        byMetric.get(r.metric)!.set(r.day, Number(r.value));
      }
      const series = (metric: string) => days.map((day) => ({ day, value: byMetric.get(metric)?.get(day) ?? 0 }));
      const northStar = series('north_star');

      const funnels = [];
      for (const f of FUNNELS) funnels.push({ key: f.key, steps: await funnel(ctx.deps, f.steps, fromDate) });

      return {
        from, to, lastRolledDay: last?.day ?? null, generatedAt: now.toISOString(),
        northStar: { key: NORTH_STAR.key, name: NORTH_STAR.name, definition: NORTH_STAR.definition, total: northStar.reduce((n, p) => n + p.value, 0), series: northStar },
        dau: series(SERIES.dau), wau: series(SERIES.wau), uploads: series(SERIES.uploads), publishes: series(SERIES.publishes),
        scoutSearches: series(SERIES.scoutSearches), contactRequests: series(SERIES.contactRequests),
        funnels,
      };
    },
  ),
];
