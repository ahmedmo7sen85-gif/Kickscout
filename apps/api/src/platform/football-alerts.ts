import { sql } from 'kysely';
import { IN_PLAY, alertMessage, detectAlerts, snapshotOf, type AlertCategory, type Match, type MatchAlert, type MatchSnapshot } from '@fp/football';
import type { Deps } from '../deps.js';
import type { PushMessage, PushSender, PushTarget } from './push.js';

interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

const LOOK_BACK_MS = 4 * 3600_000;
const LOOK_AHEAD_MS = 2 * 3600_000;
const MAX_MATCHES = 100;
const MAX_DETAIL_FETCHES = 20;
const MAX_SENDS = 500;
const MAX_ATTEMPTS = 3;
const RETRY_WINDOW_MS = 3600_000;

/** How long a push service should keep trying to deliver, by how quickly the news goes stale. */
const DELIVERY: Record<AlertCategory, { ttl: number; urgency: 'normal' | 'high' }> = {
  starting_soon: { ttl: 30 * 60, urgency: 'normal' },
  kickoff: { ttl: 15 * 60, urgency: 'high' },
  goal: { ttl: 15 * 60, urgency: 'high' },
  halftime: { ttl: 15 * 60, urgency: 'normal' },
  final_result: { ttl: 2 * 3600, urgency: 'normal' },
  lineups: { ttl: 3600, urgency: 'normal' },
};

export function matchPath(id: string) {
  return `/scores/match/${encodeURIComponent(id)}`;
}

export function alertPayload(a: MatchAlert, locale: string): PushMessage {
  const text = alertMessage(a, locale === 'ar' ? 'ar' : 'en');
  return { ...text, url: matchPath(a.match.id), tag: `m${a.match.id.replace(/[^A-Za-z0-9]/g, '').slice(-24)}` };
}

export interface AlertRunReport {
  ran: boolean;
  matchesChecked: number;
  alerts: number;
  sent: number;
  failed: number;
  removed: number;
  skippedReason: string | null;
}

type Delivery = PushTarget & { id: string; alert_key: string; category: string; payload: unknown };

/** Sends one stored delivery and records the outcome; a subscription the push service calls gone is deleted. */
async function deliver(deps: Deps, push: PushSender, d: Delivery, report: AlertRunReport) {
  const opts = DELIVERY[d.category as AlertCategory] ?? { ttl: 900, urgency: 'normal' as const };
  const res = await push.send(d, d.payload as PushMessage, { ttlSeconds: opts.ttl, urgency: opts.urgency });
  const now = deps.now();
  if (res.ok) {
    report.sent++;
    await deps.db.updateTable('push_deliveries').set((eb) => ({ status: 'sent', attempts: eb('attempts', '+', 1), updated_at: now, last_error: null }))
      .where('alert_key', '=', d.alert_key).where('subscription_id', '=', d.id).execute();
    await deps.db.updateTable('push_subscriptions').set({ last_success_at: now, failures: 0 }).where('id', '=', d.id).execute();
  } else if (res.gone) {
    report.removed++;
    await deps.db.deleteFrom('push_subscriptions').where('id', '=', d.id).execute();
  } else {
    report.failed++;
    await deps.db.updateTable('push_deliveries').set((eb) => ({ status: 'failed', attempts: eb('attempts', '+', 1), updated_at: now, last_error: res.error.slice(0, 300) }))
      .where('alert_key', '=', d.alert_key).where('subscription_id', '=', d.id).execute();
    await deps.db.updateTable('push_subscriptions').set((eb) => ({ failures: eb('failures', '+', 1) })).where('id', '=', d.id).execute();
  }
}

/**
 * One reconciliation pass: read the shared match data once, compare the matches people follow with
 * their last stored state, and push an alert for every verified transition to the subscribers who
 * asked for that category. Safe to run as often as the scheduler allows and in parallel: every
 * (alert, subscription) pair is written once (primary key) before it is sent.
 */
export async function runFootballAlerts(deps: Deps, log: Logger): Promise<AlertRunReport> {
  const report: AlertRunReport = { ran: false, matchesChecked: 0, alerts: 0, sent: 0, failed: 0, removed: 0, skippedReason: null };
  const football = deps.football;
  const push = deps.push;
  if (!football) return { ...report, skippedReason: 'football data is off (FOOTBALL_PROVIDER=off)' };
  if (!push) return { ...report, skippedReason: 'Web Push is not configured (VAPID keys missing)' };
  const provider = football.info.id;
  const db = deps.db;
  const now = deps.now();

  // Retries first: failed deliveries from the last hour, a few attempts each.
  const retries = await db.selectFrom('push_deliveries').innerJoin('push_subscriptions', 'push_subscriptions.id', 'push_deliveries.subscription_id')
    .select(['push_subscriptions.id', 'push_subscriptions.endpoint', 'push_subscriptions.p256dh', 'push_subscriptions.auth', 'push_deliveries.alert_key', 'push_deliveries.category', 'push_deliveries.payload'])
    .where('push_deliveries.status', '=', 'failed').where('push_deliveries.attempts', '<', MAX_ATTEMPTS)
    .where('push_deliveries.created_at', '>', new Date(now.getTime() - RETRY_WINDOW_MS)).limit(MAX_SENDS).execute();
  for (const d of retries) await deliver(deps, push, d, report);

  // Who wants alerts at all: people with alerts on and at least one device.
  const audience = db.selectFrom('football_alert_preferences').innerJoin('push_subscriptions', 'push_subscriptions.user_id', 'football_alert_preferences.user_id')
    .select('football_alert_preferences.user_id').where('football_alert_preferences.enabled', '=', true);
  const [teams, comps] = await Promise.all([
    db.selectFrom('favorite_teams').select('team_id').distinct().where('provider', '=', provider).where('user_id', 'in', audience).execute(),
    db.selectFrom('favorite_competitions').select('competition_id').distinct().where('provider', '=', provider).where('user_id', 'in', audience).execute(),
  ]);
  const followedTeams = new Set(teams.map((t) => t.team_id));
  const followedComps = new Set(comps.map((c) => c.competition_id));
  if (!followedTeams.size && !followedComps.size) return { ...report, ran: true, skippedReason: 'nobody with alerts on follows a team or competition' };

  // Shared data: the same cached day lists the scores page uses; no per-user provider calls.
  const days = new Set([new Date(now.getTime() - LOOK_BACK_MS), now, new Date(now.getTime() + LOOK_AHEAD_MS)].map((d) => d.toISOString().slice(0, 10)));
  const byId = new Map<string, Match>();
  for (const day of days) {
    const r = await football.matchesForDay(day, 'UTC').catch((err: unknown) => {
      log.warn({ err: String(err), day }, 'football alerts: match list unavailable');
      return null;
    });
    // Stale data never produces alerts: a transition must come from a fresh observation.
    if (!r || r.stale) continue;
    for (const m of r.matches) byId.set(m.id, m);
  }
  const lo = now.getTime() - LOOK_BACK_MS;
  const hi = now.getTime() + LOOK_AHEAD_MS;
  const watched = [...byId.values()].filter((m) => {
    const t = Date.parse(m.kickoff);
    const relevant = IN_PLAY.includes(m.status) || (t >= lo && t <= hi);
    return relevant && (followedTeams.has(m.home.id) || followedTeams.has(m.away.id) || (m.competition.id !== null && followedComps.has(m.competition.id)));
  }).slice(0, MAX_MATCHES);
  report.ran = true;
  report.matchesChecked = watched.length;
  if (!watched.length) return report;

  const prevRows = await db.selectFrom('football_match_states').selectAll().where('provider', '=', provider).where('match_id', 'in', watched.map((m) => m.id)).execute();
  const prev = new Map(prevRows.map((r): [string, MatchSnapshot] => [r.match_id, {
    status: r.status as MatchSnapshot['status'], home: r.home_score, away: r.away_score, kickoff: r.kickoff.toISOString(), lineupsConfirmed: r.lineups_confirmed,
  }]));

  let detailBudget = football.info.capabilities.lineups ? MAX_DETAIL_FETCHES : 0;
  const alerts: MatchAlert[] = [];
  for (const m of watched) {
    let lineups = prev.get(m.id)?.lineupsConfirmed ?? false;
    const soon = Date.parse(m.kickoff) - now.getTime() <= 90 * 60_000;
    if (!lineups && detailBudget > 0 && soon && (m.status === 'scheduled' || IN_PLAY.includes(m.status))) {
      detailBudget--;
      const d = await football.match(m.id).catch(() => null);
      lineups = Boolean(d && !d.stale && d.data?.lineups?.confirmed);
    }
    alerts.push(...detectAlerts(prev.get(m.id) ?? null, m, now, lineups));
    const s = snapshotOf(m, lineups);
    await db.insertInto('football_match_states')
      .values({ provider, match_id: m.id, status: s.status, home_score: s.home, away_score: s.away, kickoff: new Date(s.kickoff), lineups_confirmed: s.lineupsConfirmed, observed_at: now })
      .onConflict((oc) => oc.columns(['provider', 'match_id']).doUpdateSet({
        status: s.status, home_score: s.home, away_score: s.away, kickoff: new Date(s.kickoff), lineups_confirmed: s.lineupsConfirmed, observed_at: now,
      }))
      .execute();
  }
  report.alerts = alerts.length;

  let budget = MAX_SENDS - retries.length;
  for (const a of alerts) {
    if (budget <= 0) break;
    const m = a.match;
    const followers = db.selectFrom('favorite_teams').select('user_id').where('provider', '=', provider).where('team_id', 'in', [m.home.id, m.away.id])
      .union(db.selectFrom('favorite_competitions').select('user_id').where('provider', '=', provider).where('competition_id', '=', m.competition.id ?? '\u0000'));
    const subs = await db.selectFrom('push_subscriptions')
      .innerJoin('football_alert_preferences as p', 'p.user_id', 'push_subscriptions.user_id')
      .select(['push_subscriptions.id', 'push_subscriptions.endpoint', 'push_subscriptions.p256dh', 'push_subscriptions.auth', 'push_subscriptions.locale'])
      .where('p.enabled', '=', true)
      .where(sql.ref(`p.${a.category}`), '=', true)
      .where('push_subscriptions.user_id', 'in', followers)
      .limit(budget).execute();
    for (const s of subs) {
      const payload = alertPayload(a, s.locale);
      // The insert is the idempotency check: a second run (or a parallel one) finds the row and sends nothing.
      const claimed = await db.insertInto('push_deliveries')
        .values({ alert_key: a.key, subscription_id: s.id, category: a.category, payload: JSON.stringify(payload) })
        .onConflict((oc) => oc.columns(['alert_key', 'subscription_id']).doNothing())
        .returning('subscription_id').executeTakeFirst();
      if (!claimed) continue;
      budget--;
      await deliver(deps, push, { ...s, alert_key: a.key, category: a.category, payload }, report);
    }
  }

  // Housekeeping: snapshots of long-finished matches and old delivery rows.
  await db.deleteFrom('football_match_states').where('observed_at', '<', new Date(now.getTime() - 3 * 86_400_000)).execute();
  await db.deleteFrom('push_deliveries').where('created_at', '<', new Date(now.getTime() - 14 * 86_400_000)).execute();
  await db.deleteFrom('football_cache').where('fresh_until', '<', new Date(now.getTime() - 7 * 86_400_000)).execute();
  log.info({ ...report }, 'football alerts run');
  return report;
}
