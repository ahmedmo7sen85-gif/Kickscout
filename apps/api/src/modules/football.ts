import { timingSafeEqual } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { DB } from '@fp/db';
import {
  AlertPreferencesView, CompetitionsView, FavoriteImportRequest, FavoritesView, FootballCronReport, FootballSearchQuery, FootballSearchView,
  FootballStatusView, MatchDetailResponse, MatchListQuery, MatchListView, PushConfigView, PushEndpointRequest, PushStatusView, PushSubscribeRequest,
  PushTestResult, StandingsView, TeamMatchesView, UpdateAlertPreferencesRequest,
} from '@fp/contracts';
import { ALERT_CATEGORIES, IN_PLAY, dayIn, isValidDay, isValidTimeZone, type AlertCategory, type Match } from '@fp/football';
import { route } from '../platform/route.js';
import { ApiError, notFound } from '../platform/errors.js';
import { footballOf, type FootballService } from '../platform/football.js';
import { isAllowedPushEndpoint } from '../platform/push.js';
import { runFootballAlerts } from '../platform/football-alerts.js';
import { newId } from '../platform/ids.js';
import type { Deps } from '../deps.js';

const MAX_FAVORITES = 50;
const MAX_DEVICES = 10;
const ID = /^[A-Za-z0-9~_-]{1,130}$/;

function sourceOf(f: FootballService, fetchedAt: Date | null, stale: boolean) {
  const i = f.info;
  return {
    provider: i.id, name: i.name, homepage: i.homepage, attribution: i.attribution, testData: i.testData, coverageNote: i.coverageNote,
    capabilities: i.capabilities, fetchedAt: fetchedAt?.toISOString() ?? null, stale,
  };
}

function idParam(v: string | undefined, what: string): string {
  if (!v || !ID.test(v)) throw notFound(what);
  return v;
}

function bearerIs(header: string | undefined, secret: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Alert categories this data source cannot produce; they are reported and never promised. */
function unsupportedCategories(f: FootballService | null | undefined): AlertCategory[] {
  if (!f) return [...ALERT_CATEGORIES];
  return f.info.capabilities.lineups ? [] : ['lineups'];
}

const DEFAULT_CATEGORIES: Record<AlertCategory, boolean> = { starting_soon: false, kickoff: true, goal: true, halftime: false, final_result: true, lineups: false };

async function alertPrefs(deps: Deps, userId: string) {
  const row = await deps.db.selectFrom('football_alert_preferences').selectAll().where('user_id', '=', userId).executeTakeFirst();
  const categories = Object.fromEntries(ALERT_CATEGORIES.map((c) => [c, row ? row[c] : DEFAULT_CATEGORIES[c]])) as Record<AlertCategory, boolean>;
  return { enabled: row?.enabled ?? false, categories, unsupported: unsupportedCategories(deps.football) };
}

async function favorites(deps: Deps, userId: string) {
  const provider = deps.football?.info.id ?? null;
  if (!provider) return { provider, teams: [], competitions: [] };
  const [teams, comps] = await Promise.all([
    deps.db.selectFrom('favorite_teams').innerJoin('football_teams', (j) => j.onRef('football_teams.provider', '=', 'favorite_teams.provider').onRef('football_teams.id', '=', 'favorite_teams.team_id'))
      .select(['football_teams.id', 'football_teams.name', 'football_teams.logo_url']).where('favorite_teams.user_id', '=', userId).where('favorite_teams.provider', '=', provider)
      .orderBy('favorite_teams.created_at').execute(),
    deps.db.selectFrom('favorite_competitions').innerJoin('football_competitions', (j) => j.onRef('football_competitions.provider', '=', 'favorite_competitions.provider').onRef('football_competitions.id', '=', 'favorite_competitions.competition_id'))
      .select(['football_competitions.id', 'football_competitions.name', 'football_competitions.logo_url', 'football_competitions.area'])
      .where('favorite_competitions.user_id', '=', userId).where('favorite_competitions.provider', '=', provider).orderBy('favorite_competitions.created_at').execute(),
  ]);
  return {
    provider,
    teams: teams.map((t) => ({ id: t.id, name: t.name, logoUrl: t.logo_url })),
    competitions: comps.map((c) => ({ id: c.id, name: c.name, logoUrl: c.logo_url, area: c.area })),
  };
}

/**
 * Adds favourites by id. Only teams and competitions that exist in the provider directory can be
 * added (names and logos come from provider data, never from the client), at most 50 of each.
 */
async function addFavorites(deps: Deps, userId: string, kind: 'team' | 'competition', ids: string[]) {
  const f = footballOf(deps);
  const provider = f.info.id;
  const clean = [...new Set(ids.filter((i) => ID.test(i)))];
  if (!clean.length) return 0;
  return deps.db.transaction().execute(async (tx) => {
    // Serialises concurrent adds by the same person so the cap cannot be raced past.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`fav:${userId}`}))`.execute(tx);
    const known = kind === 'team'
      ? await tx.selectFrom('football_teams').select('id').where('provider', '=', provider).where('id', 'in', clean).execute()
      : await tx.selectFrom('football_competitions').select('id').where('provider', '=', provider).where('id', 'in', clean).execute();
    const table = kind === 'team' ? 'favorite_teams' : 'favorite_competitions';
    const count = await tx.selectFrom(table).select(tx.fn.countAll<string>().as('n')).where('user_id', '=', userId).where('provider', '=', provider).executeTakeFirstOrThrow();
    const room = MAX_FAVORITES - Number(count.n);
    const add = known.map((k) => k.id);
    if (!add.length) return 0;
    if (room <= 0) throw new ApiError(409, 'FAVORITES_LIMIT', `you can follow up to ${MAX_FAVORITES} ${kind === 'team' ? 'teams' : 'competitions'}`);
    const rows = add.slice(0, room);
    const res = kind === 'team'
      ? await tx.insertInto('favorite_teams').values(rows.map((id) => ({ user_id: userId, provider, team_id: id })))
        .onConflict((oc) => oc.columns(['user_id', 'provider', 'team_id']).doNothing()).execute()
      : await tx.insertInto('favorite_competitions').values(rows.map((id) => ({ user_id: userId, provider, competition_id: id })))
        .onConflict((oc) => oc.columns(['user_id', 'provider', 'competition_id']).doNothing()).execute();
    return res.reduce((n, r) => n + Number(r.numInsertedOrUpdatedRows ?? 0), 0);
  });
}

/** Part of account deletion: favourites, alert settings and push devices go with the account. */
export async function eraseFootballData(tx: Transaction<DB>, userId: string) {
  await tx.deleteFrom('favorite_teams').where('user_id', '=', userId).execute();
  await tx.deleteFrom('favorite_competitions').where('user_id', '=', userId).execute();
  await tx.deleteFrom('football_alert_preferences').where('user_id', '=', userId).execute();
  await tx.deleteFrom('push_subscriptions').where('user_id', '=', userId).execute();
}

/** For the data export: what you follow and your alert settings. Device endpoints are capability URLs and stay out. */
export async function footballExport(deps: Deps, userId: string) {
  const [fav, prefs, devices] = await Promise.all([
    favorites(deps, userId),
    alertPrefs(deps, userId),
    deps.db.selectFrom('push_subscriptions').select(['created_at', 'locale']).where('user_id', '=', userId).execute(),
  ]);
  return {
    teams: fav.teams.map((t) => ({ id: t.id, name: t.name })),
    competitions: fav.competitions.map((c) => ({ id: c.id ?? '', name: c.name })),
    alerts: { enabled: prefs.enabled, categories: prefs.categories },
    pushDevices: devices.map((d) => ({ registeredAt: d.created_at.toISOString(), locale: d.locale })),
  };
}

function filterStatus(m: Match, status: 'all' | 'live' | 'upcoming' | 'finished') {
  if (status === 'live') return IN_PLAY.includes(m.status);
  if (status === 'upcoming') return m.status === 'scheduled';
  if (status === 'finished') return m.status === 'finished';
  return true;
}

export const footballRoutes = [
  route(
    { method: 'get', path: '/v1/football/status', summary: 'Football data source, its limits and health; whether match alerts can be delivered', tag: 'football', auth: 'none', response: FootballStatusView },
    async (ctx) => {
      const f = ctx.deps.football;
      if (!f) return { enabled: false, source: null, health: null, push: { available: Boolean(ctx.deps.push) } };
      const health = await f.health();
      return {
        enabled: true, source: sourceOf(f, health.lastSuccessAt ? new Date(health.lastSuccessAt) : null, health.consecutiveFailures > 0),
        health, push: { available: Boolean(ctx.deps.push) },
      };
    },
  ),
  route(
    { method: 'get', path: '/v1/football/matches', summary: 'Matches on a calendar day in a time zone (default: today, UTC), with filters and provenance', tag: 'football', auth: 'none', query: MatchListQuery, response: MatchListView, rateLimit: { max: 120, timeWindow: '1 minute' } },
    async (ctx) => {
      const f = footballOf(ctx.deps);
      const tz = ctx.query.tz ?? 'UTC';
      if (!isValidTimeZone(tz)) throw new ApiError(400, 'INVALID_TIME_ZONE', 'unknown time zone');
      const day = ctx.query.date ?? dayIn(ctx.deps.now(), tz);
      if (!isValidDay(day)) throw new ApiError(400, 'INVALID_DATE', 'date must be a real calendar day (YYYY-MM-DD)');
      const r = await f.matchesForDay(day, tz);
      const competitions = [...new Map(r.matches.map((m) => [m.competition.id ?? m.competition.name, m.competition])).values()]
        .sort((a, b) => a.name.localeCompare(b.name));
      const matches = r.matches
        .filter((m) => !ctx.query.competition || m.competition.id === ctx.query.competition)
        .filter((m) => filterStatus(m, ctx.query.status));
      return {
        source: sourceOf(f, r.fetchedAt, r.stale), day, timeZone: tz, range: { start: r.start.toISOString(), end: r.end.toISOString() },
        coverage: r.coverage, competitions, matches,
      };
    },
  ),
  route(
    { method: 'get', path: '/v1/football/matches/:id', summary: 'One match with events, line-ups and stats when the source supplies them', tag: 'football', auth: 'none', response: MatchDetailResponse },
    async (ctx) => {
      const f = footballOf(ctx.deps);
      const r = await f.match(idParam(ctx.params.id, 'match'));
      if (!r.data) throw notFound('match');
      return { source: sourceOf(f, r.fetchedAt, r.stale), match: r.data };
    },
  ),
  route(
    { method: 'get', path: '/v1/football/teams/:id', summary: 'A team’s recent and upcoming matches', tag: 'football', auth: 'none', response: TeamMatchesView },
    async (ctx) => {
      const f = footballOf(ctx.deps);
      if (!f.info.capabilities.teamMatches) throw new ApiError(404, 'NOT_SUPPORTED_BY_PROVIDER', `${f.info.name} does not provide team fixtures`);
      const r = await f.team(idParam(ctx.params.id, 'team'));
      if (!r.data) throw notFound('team');
      const matches = [...r.data.matches].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
      return { source: sourceOf(f, r.fetchedAt, r.stale), team: r.data.team, matches };
    },
  ),
  route(
    { method: 'get', path: '/v1/football/competitions', summary: 'Competitions the data source covers', tag: 'football', auth: 'none', response: CompetitionsView },
    async (ctx) => {
      const f = footballOf(ctx.deps);
      const r = await f.competitions();
      return { source: sourceOf(f, r.fetchedAt, r.stale), competitions: r.data };
    },
  ),
  route(
    { method: 'get', path: '/v1/football/competitions/:id/standings', summary: 'League table when the source supplies one', tag: 'football', auth: 'none', response: StandingsView },
    async (ctx) => {
      const f = footballOf(ctx.deps);
      if (!f.info.capabilities.standings) throw new ApiError(404, 'NOT_SUPPORTED_BY_PROVIDER', `${f.info.name} does not provide standings`);
      const r = await f.standings(idParam(ctx.params.id, 'competition'));
      if (!r.data) throw notFound('standings');
      return { source: sourceOf(f, r.fetchedAt, r.stale), competition: r.data.competition, season: r.data.season, groups: r.data.groups };
    },
  ),
  route(
    { method: 'get', path: '/v1/football/search', summary: 'Teams and competitions seen in the data source, by name', tag: 'football', auth: 'none', query: FootballSearchQuery, response: FootballSearchView, rateLimit: { max: 60, timeWindow: '1 minute' } },
    async (ctx) => {
      const f = footballOf(ctx.deps);
      const like = `%${ctx.query.q.toLowerCase().replace(/[\\%_]/g, (c: string) => `\\${c}`)}%`;
      const [teams, comps] = await Promise.all([
        ctx.deps.db.selectFrom('football_teams').select(['id', 'name', 'logo_url']).where('provider', '=', f.info.id)
          .where(sql<boolean>`lower(name) LIKE ${like}`).orderBy('last_seen_at', 'desc').limit(20).execute(),
        ctx.deps.db.selectFrom('football_competitions').select(['id', 'name', 'logo_url', 'area']).where('provider', '=', f.info.id)
          .where(sql<boolean>`lower(name) LIKE ${like}`).orderBy('last_seen_at', 'desc').limit(10).execute(),
      ]);
      return {
        teams: teams.map((t) => ({ id: t.id, name: t.name, logoUrl: t.logo_url })),
        competitions: comps.map((c) => ({ id: c.id, name: c.name, logoUrl: c.logo_url, area: c.area })),
      };
    },
  ),

  // ------------------------------------------------------------ favourites (signed in)
  route(
    { method: 'get', path: '/v1/me/football/favorites', summary: 'My favourite teams and competitions', tag: 'football', auth: 'user', response: FavoritesView },
    async (ctx) => favorites(ctx.deps, ctx.me().userId),
  ),
  route(
    { method: 'put', path: '/v1/me/football/favorites/teams/:id', summary: 'Follow a team', tag: 'football', auth: 'user', response: FavoritesView, rateLimit: { max: 60, timeWindow: '1 minute' } },
    async (ctx) => {
      const me = ctx.me();
      const id = idParam(ctx.params.id, 'team');
      if (!(await addFavorites(ctx.deps, me.userId, 'team', [id]))) {
        const exists = await ctx.deps.db.selectFrom('favorite_teams').select('team_id').where('user_id', '=', me.userId).where('provider', '=', footballOf(ctx.deps).info.id).where('team_id', '=', id).executeTakeFirst();
        if (!exists) throw notFound('team');
      }
      return favorites(ctx.deps, me.userId);
    },
  ),
  route(
    { method: 'delete', path: '/v1/me/football/favorites/teams/:id', summary: 'Unfollow a team', tag: 'football', auth: 'user', response: FavoritesView },
    async (ctx) => {
      const me = ctx.me();
      await ctx.deps.db.deleteFrom('favorite_teams').where('user_id', '=', me.userId).where('provider', '=', footballOf(ctx.deps).info.id).where('team_id', '=', idParam(ctx.params.id, 'team')).execute();
      return favorites(ctx.deps, me.userId);
    },
  ),
  route(
    { method: 'put', path: '/v1/me/football/favorites/competitions/:id', summary: 'Follow a competition', tag: 'football', auth: 'user', response: FavoritesView, rateLimit: { max: 60, timeWindow: '1 minute' } },
    async (ctx) => {
      const me = ctx.me();
      const id = idParam(ctx.params.id, 'competition');
      if (!(await addFavorites(ctx.deps, me.userId, 'competition', [id]))) {
        const exists = await ctx.deps.db.selectFrom('favorite_competitions').select('competition_id').where('user_id', '=', me.userId).where('provider', '=', footballOf(ctx.deps).info.id).where('competition_id', '=', id).executeTakeFirst();
        if (!exists) throw notFound('competition');
      }
      return favorites(ctx.deps, me.userId);
    },
  ),
  route(
    { method: 'delete', path: '/v1/me/football/favorites/competitions/:id', summary: 'Unfollow a competition', tag: 'football', auth: 'user', response: FavoritesView },
    async (ctx) => {
      const me = ctx.me();
      await ctx.deps.db.deleteFrom('favorite_competitions').where('user_id', '=', me.userId).where('provider', '=', footballOf(ctx.deps).info.id).where('competition_id', '=', idParam(ctx.params.id, 'competition')).execute();
      return favorites(ctx.deps, me.userId);
    },
  ),
  route(
    { method: 'post', path: '/v1/me/football/favorites/import', summary: 'Save favourites picked before signing in (unknown ids are ignored, duplicates merge)', tag: 'football', auth: 'user', body: FavoriteImportRequest, response: FavoritesView, rateLimit: { max: 10, timeWindow: '1 minute' } },
    async (ctx) => {
      const me = ctx.me();
      for (const [kind, ids] of [['team', ctx.body.teams], ['competition', ctx.body.competitions]] as const) {
        try {
          await addFavorites(ctx.deps, me.userId, kind, ids);
        } catch (err) {
          // A full list keeps what is saved; the import never fails because of the cap.
          if (!(err instanceof ApiError && err.code === 'FAVORITES_LIMIT')) throw err;
        }
      }
      return favorites(ctx.deps, me.userId);
    },
  ),

  // ------------------------------------------------------------ match alerts and Web Push
  route(
    { method: 'get', path: '/v1/me/football/alerts', summary: 'My match alert settings', tag: 'football', auth: 'user', response: AlertPreferencesView },
    async (ctx) => alertPrefs(ctx.deps, ctx.me().userId),
  ),
  route(
    { method: 'patch', path: '/v1/me/football/alerts', summary: 'Turn match alerts, or single categories, on or off', tag: 'football', auth: 'user', body: UpdateAlertPreferencesRequest, response: AlertPreferencesView },
    async (ctx) => {
      const me = ctx.me();
      const current = await alertPrefs(ctx.deps, me.userId);
      const categories = { ...current.categories, ...ctx.body.categories };
      const values = { enabled: ctx.body.enabled ?? current.enabled, ...categories, updated_at: ctx.deps.now() };
      await ctx.deps.db.insertInto('football_alert_preferences').values({ user_id: me.userId, ...values })
        .onConflict((oc) => oc.column('user_id').doUpdateSet(values)).execute();
      return alertPrefs(ctx.deps, me.userId);
    },
  ),
  route(
    { method: 'get', path: '/v1/push/config', summary: 'Whether Web Push is available, and the public VAPID key browsers subscribe with', tag: 'football', auth: 'none', response: PushConfigView },
    async (ctx) => ({ available: Boolean(ctx.deps.push), publicKey: ctx.deps.push?.publicKey ?? null }),
  ),
  route(
    { method: 'post', path: '/v1/me/push/subscriptions', summary: 'Register this browser for push alerts (after the person allowed notifications)', tag: 'football', auth: 'user', body: PushSubscribeRequest, response: PushStatusView, rateLimit: { max: 10, timeWindow: '1 minute' } },
    async (ctx) => {
      const me = ctx.me();
      if (!ctx.deps.push) throw new ApiError(503, 'PUSH_NOT_CONFIGURED', 'push notifications are not enabled on this server');
      if (!isAllowedPushEndpoint(ctx.body.endpoint)) throw new ApiError(400, 'PUSH_ENDPOINT_NOT_ALLOWED', 'this push service is not supported');
      const now = ctx.deps.now();
      await ctx.deps.db.transaction().execute(async (tx) => {
        // One endpoint is one browser: whoever is signed in there now receives its alerts.
        await tx.insertInto('push_subscriptions')
          .values({ id: newId(), user_id: me.userId, endpoint: ctx.body.endpoint, p256dh: ctx.body.keys.p256dh, auth: ctx.body.keys.auth, locale: ctx.body.locale, created_at: now })
          .onConflict((oc) => oc.column('endpoint').doUpdateSet({ user_id: me.userId, p256dh: ctx.body.keys.p256dh, auth: ctx.body.keys.auth, locale: ctx.body.locale, failures: 0 }))
          .execute();
        const extra = await tx.selectFrom('push_subscriptions').select('id').where('user_id', '=', me.userId).orderBy('created_at', 'desc').offset(MAX_DEVICES).limit(100).execute();
        if (extra.length) await tx.deleteFrom('push_subscriptions').where('id', 'in', extra.map((e) => e.id)).execute();
      });
      const n = await ctx.deps.db.selectFrom('push_subscriptions').select(ctx.deps.db.fn.countAll<string>().as('n')).where('user_id', '=', me.userId).executeTakeFirstOrThrow();
      return { registered: true, devices: Number(n.n) };
    },
  ),
  route(
    { method: 'post', path: '/v1/me/push/subscriptions/remove', summary: 'Stop push alerts on this browser', tag: 'football', auth: 'user', body: PushEndpointRequest, response: PushStatusView },
    async (ctx) => {
      const me = ctx.me();
      await ctx.deps.db.deleteFrom('push_subscriptions').where('user_id', '=', me.userId).where('endpoint', '=', ctx.body.endpoint).execute();
      const n = await ctx.deps.db.selectFrom('push_subscriptions').select(ctx.deps.db.fn.countAll<string>().as('n')).where('user_id', '=', me.userId).executeTakeFirstOrThrow();
      return { registered: false, devices: Number(n.n) };
    },
  ),
  route(
    { method: 'post', path: '/v1/me/push/status', summary: 'Whether this browser is registered for my alerts, and how many devices are', tag: 'football', auth: 'user', body: PushEndpointRequest, response: PushStatusView },
    async (ctx) => {
      const me = ctx.me();
      const rows = await ctx.deps.db.selectFrom('push_subscriptions').select('endpoint').where('user_id', '=', me.userId).execute();
      return { registered: rows.some((r) => r.endpoint === ctx.body.endpoint), devices: rows.length };
    },
  ),
  route(
    { method: 'post', path: '/v1/me/push/test', summary: 'Send a test notification to my registered browsers', tag: 'football', auth: 'user', response: PushTestResult, rateLimit: { max: 3, timeWindow: '1 minute' } },
    async (ctx) => {
      const me = ctx.me();
      const push = ctx.deps.push;
      if (!push) throw new ApiError(503, 'PUSH_NOT_CONFIGURED', 'push notifications are not enabled on this server');
      const subs = await ctx.deps.db.selectFrom('push_subscriptions').select(['id', 'endpoint', 'p256dh', 'auth', 'locale']).where('user_id', '=', me.userId).execute();
      if (!subs.length) throw new ApiError(409, 'NO_PUSH_DEVICES', 'turn on notifications in this browser first');
      const out = { sent: 0, failed: 0, removed: 0 };
      for (const s of subs) {
        const ar = s.locale === 'ar';
        const res = await push.send(s, {
          title: ar ? 'إشعار تجريبي من KICKSCOUT' : 'KICKSCOUT test notification',
          body: ar ? 'التنبيهات تعمل على هذا الجهاز.' : 'Match alerts work on this device.',
          url: '/following', tag: 'test',
        }, { ttlSeconds: 300, urgency: 'normal' });
        if (res.ok) out.sent++;
        else if (res.gone) {
          out.removed++;
          await ctx.deps.db.deleteFrom('push_subscriptions').where('id', '=', s.id).execute();
        } else out.failed++;
      }
      return out;
    },
  ),
  route(
    { method: 'get', path: '/v1/cron/football', summary: 'Scheduled match-alert reconciliation (Bearer CRON_SECRET); run every 1-5 minutes from a scheduler', tag: 'football', auth: 'none', response: FootballCronReport, rateLimit: { max: 30, timeWindow: '1 minute' } },
    async (ctx) => {
      const secret = ctx.deps.config.CRON_SECRET;
      if (!secret) throw new ApiError(503, 'CRON_NOT_CONFIGURED', 'set CRON_SECRET to enable scheduled jobs');
      if (!bearerIs(ctx.req.headers.authorization, secret)) throw new ApiError(401, 'UNAUTHENTICATED', 'cron secret required');
      return runFootballAlerts(ctx.deps, ctx.req.log);
    },
  ),
];
