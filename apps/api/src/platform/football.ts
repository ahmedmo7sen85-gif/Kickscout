import { sql } from 'kysely';
import type { Database } from '@fp/db';
import {
  FixtureProvider, FootballDataProvider, ProviderError, SportScoreProvider, dayIn, freshForSeconds, localDayRange, utcDaysCovering,
  type CompetitionRef, type FootballProvider, type Match, type MatchDetail, type Standings, type TeamRef,
} from '@fp/football';
import type { Config } from '../config.js';
import { ApiError } from './errors.js';

/** The configured football data source, or null when FOOTBALL_PROVIDER=off. */
export function footballProviderFromConfig(config: Config): FootballProvider | null {
  switch (config.FOOTBALL_PROVIDER) {
    case 'sportscore':
      return new SportScoreProvider({ appName: 'kickscout' });
    case 'football-data':
      return new FootballDataProvider(config.FOOTBALL_DATA_API_KEY ?? '');
    case 'fixture':
      return new FixtureProvider();
    case 'off':
      return null;
  }
}

export interface Cached<T> {
  data: T;
  fetchedAt: Date | null;
  stale: boolean;
}

interface Logger {
  warn(obj: object, msg: string): void;
}

const MAX_BACKOFF_SECONDS = 600;

/**
 * Shared, provider-agnostic access to football data. Every answer goes through one Postgres cache
 * row per request shape, so all API instances (and every visitor) share one provider call per
 * freshness window instead of polling per user. On failure the last good copy is served marked
 * `stale`, and further calls back off exponentially (or as long as the provider's Retry-After asks).
 */
export class FootballService {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    readonly provider: FootballProvider,
    private readonly db: Database,
    private readonly now: () => Date,
    private readonly log?: Logger,
  ) {}

  get info() {
    return this.provider.info;
  }

  private key(k: string) {
    return `${this.provider.info.id}:${k}`;
  }

  /** Reads through the cache. A `null` answer (not found) is cached too, so unknown ids do not hammer the provider. */
  async cached<T>(rawKey: string, ttl: (data: T) => number, load: () => Promise<T>): Promise<Cached<T>> {
    const key = this.key(rawKey);
    const now = this.now();
    const row = await this.db.selectFrom('football_cache').selectAll().where('key', '=', key).executeTakeFirst();
    const have = row?.payload ? ((row.payload as { v: T }).v) : undefined;
    if (row && have !== undefined && row.fresh_until && row.fresh_until > now) return { data: have, fetchedAt: row.fetched_at, stale: false };
    if (row?.retry_after && row.retry_after > now) {
      if (have !== undefined) return { data: have, fetchedAt: row.fetched_at, stale: true };
      throw unavailable();
    }

    const running = this.inflight.get(key) as Promise<Cached<T>> | undefined;
    if (running) return running;
    const p = this.refresh(key, row?.failures ?? 0, ttl, load, have, row?.fetched_at ?? null).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async refresh<T>(key: string, failures: number, ttl: (data: T) => number, load: () => Promise<T>, have: T | undefined, fetchedAt: Date | null): Promise<Cached<T>> {
    const now = this.now();
    try {
      const data = await load();
      const freshUntil = new Date(now.getTime() + ttl(data) * 1000);
      await this.db.insertInto('football_cache')
        .values({ key, provider: this.provider.info.id, payload: JSON.stringify({ v: data }), fetched_at: now, fresh_until: freshUntil, failures: 0 })
        .onConflict((oc) => oc.column('key').doUpdateSet({
          payload: JSON.stringify({ v: data }), fetched_at: now, fresh_until: freshUntil, failures: 0, retry_after: null, last_error: null,
        }))
        .execute();
      return { data, fetchedAt: now, stale: false };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_supported') throw new ApiError(404, 'NOT_SUPPORTED_BY_PROVIDER', `${this.provider.info.name} does not provide this`);
      const kind = err instanceof ProviderError ? err.kind : 'unavailable';
      const n = failures + 1;
      const wait = err instanceof ProviderError && err.retryAfterSeconds !== null ? err.retryAfterSeconds : Math.min(15 * 2 ** (n - 1), MAX_BACKOFF_SECONDS);
      const retryAfter = new Date(now.getTime() + wait * 1000);
      this.log?.warn({ provider: this.provider.info.id, cacheKey: key, kind, failures: n }, 'football provider call failed');
      await this.db.insertInto('football_cache')
        .values({ key, provider: this.provider.info.id, payload: null, failures: n, retry_after: retryAfter, last_error: kind, last_error_at: now })
        .onConflict((oc) => oc.column('key').doUpdateSet({ failures: n, retry_after: retryAfter, last_error: kind, last_error_at: now }))
        .execute()
        .catch(() => {});
      if (have !== undefined) return { data: have, fetchedAt, stale: true };
      throw unavailable();
    }
  }

  /** Matches with kickoff on a calendar day in `tz`, from as many UTC days as that local day touches. */
  async matchesForDay(day: string, tz: string) {
    const { start, end } = localDayRange(day, tz);
    const today = dayIn(this.now(), 'UTC');
    const parts: Cached<Match[]>[] = [];
    if (this.info.capabilities.dateRange) {
      for (const d of utcDaysCovering(start, end)) {
        parts.push(await this.cached(`matches:day:${d}`, (ms) => freshForSeconds('matches', { matches: ms, day: d, today }), async () => {
          const ms = await this.provider.matches(d, d);
          await this.remember(ms);
          return ms;
        }));
      }
    } else {
      parts.push(await this.cached('matches:window', (ms) => freshForSeconds('matches', { matches: ms }), async () => {
        const ms = await this.provider.matches(today, today);
        await this.remember(ms);
        return ms;
      }));
    }
    const seen = new Set<string>();
    const matches = parts.flatMap((p) => p.data).filter((m) => {
      const t = Date.parse(m.kickoff);
      if (t < start.getTime() || t >= end.getTime() || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    }).sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.competition.name.localeCompare(b.competition.name));
    const fetched = parts.map((p) => p.fetchedAt?.getTime() ?? 0);
    return {
      matches, start, end,
      coverage: this.info.capabilities.dateRange ? 'day' as const : 'recent-window' as const,
      fetchedAt: fetched.length && Math.min(...fetched) > 0 ? new Date(Math.min(...fetched)) : null,
      stale: parts.some((p) => p.stale),
    };
  }

  match(id: string): Promise<Cached<MatchDetail | null>> {
    return this.cached(`match:${id}`, (m) => (m ? freshForSeconds('match', { status: m.status }) : 600), async () => {
      const m = await this.provider.match(id);
      if (m) await this.remember([m]);
      return m;
    });
  }

  team(id: string): Promise<Cached<{ team: TeamRef; matches: Match[] } | null>> {
    return this.cached(`team:${id}`, () => freshForSeconds('team', {}), async () => {
      const t = await this.provider.teamMatches(id);
      if (t) {
        await this.rememberTeams([t.team]);
        await this.remember(t.matches);
      }
      return t;
    });
  }

  standings(id: string): Promise<Cached<Standings | null>> {
    return this.cached(`standings:${id}`, () => freshForSeconds('standings', {}), async () => {
      const s = await this.provider.standings(id);
      if (s) {
        await this.rememberCompetitions([s.competition]);
        await this.rememberTeams(s.groups.flatMap((g) => g.rows.map((r) => r.team)));
      }
      return s;
    });
  }

  competitions(): Promise<Cached<CompetitionRef[]>> {
    return this.cached('competitions', () => freshForSeconds('competitions', {}), async () => {
      const cs = await this.provider.competitions();
      await this.rememberCompetitions(cs);
      return cs;
    });
  }

  /** Last success and failure across this provider's cache rows (for status pages and ops reports). */
  async health() {
    const r = await this.db.selectFrom('football_cache')
      .select([
        sql<Date | null>`max(fetched_at)`.as('last_success'),
        sql<Date | null>`max(last_error_at)`.as('last_error_at'),
        sql<number>`coalesce(max(failures), 0)::int`.as('failures'),
      ])
      .where('provider', '=', this.provider.info.id).executeTakeFirst();
    const lastErr = r?.last_error_at
      ? await this.db.selectFrom('football_cache').select('last_error').where('provider', '=', this.provider.info.id).orderBy('last_error_at', 'desc').limit(1).executeTakeFirst()
      : null;
    return {
      lastSuccessAt: r?.last_success ? new Date(r.last_success).toISOString() : null,
      lastErrorAt: r?.last_error_at ? new Date(r.last_error_at).toISOString() : null,
      lastErrorKind: lastErr?.last_error ?? null,
      consecutiveFailures: Number(r?.failures ?? 0),
    };
  }

  /** Teams and competitions seen in provider data become searchable and can be favourited. */
  private async remember(matches: Match[]) {
    await this.rememberTeams(matches.flatMap((m) => [m.home, m.away]));
    await this.rememberCompetitions(matches.map((m) => m.competition));
  }

  private async rememberTeams(teams: TeamRef[]) {
    const unique = [...new Map(teams.filter((t) => t.id && t.name).map((t) => [t.id, t])).values()].slice(0, 500);
    if (!unique.length) return;
    const now = this.now();
    await this.db.insertInto('football_teams')
      .values(unique.map((t) => ({ provider: this.provider.info.id, id: t.id.slice(0, 80), name: t.name.slice(0, 120), logo_url: t.logoUrl, last_seen_at: now })))
      .onConflict((oc) => oc.columns(['provider', 'id']).doUpdateSet((eb) => ({ name: eb.ref('excluded.name'), logo_url: eb.ref('excluded.logo_url'), last_seen_at: now })))
      .execute()
      .catch((err: unknown) => this.log?.warn({ err: String(err) }, 'could not record football teams'));
  }

  private async rememberCompetitions(cs: CompetitionRef[]) {
    const unique = [...new Map(cs.filter((c): c is CompetitionRef & { id: string } => Boolean(c.id && c.name)).map((c) => [c.id, c])).values()].slice(0, 200);
    if (!unique.length) return;
    const now = this.now();
    await this.db.insertInto('football_competitions')
      .values(unique.map((c) => ({ provider: this.provider.info.id, id: c.id.slice(0, 80), name: c.name.slice(0, 120), logo_url: c.logoUrl, area: c.area?.slice(0, 80) ?? null, last_seen_at: now })))
      .onConflict((oc) => oc.columns(['provider', 'id']).doUpdateSet((eb) => ({ name: eb.ref('excluded.name'), logo_url: eb.ref('excluded.logo_url'), area: eb.ref('excluded.area'), last_seen_at: now })))
      .execute()
      .catch((err: unknown) => this.log?.warn({ err: String(err) }, 'could not record football competitions'));
  }
}

function unavailable() {
  return new ApiError(503, 'FOOTBALL_PROVIDER_UNAVAILABLE', 'football data is temporarily unavailable from the provider');
}

/** The service for these deps, or a 503 that says football data is switched off. */
export function footballOf(deps: { football?: FootballService | null }): FootballService {
  if (!deps.football) throw new ApiError(503, 'FOOTBALL_DISABLED', 'football data is not configured on this server');
  return deps.football;
}
