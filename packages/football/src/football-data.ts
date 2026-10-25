import { getJson, httpsUrl, toInt, toIsoUtc, type HttpOptions } from './http.js';
import { footballDataStatus } from './status.js';
import type { CompetitionRef, FootballProvider, Match, MatchDetail, MatchEvent, ProviderInfo, Standings, StandingRow, TeamRef } from './types.js';
import { ProviderError } from './types.js';

/**
 * football-data.org API v4 (https://www.football-data.org/), checked 2026-10-25.
 *
 * - Needs a free API key (header X-Auth-Token), kept on the server only.
 * - Free tier: 12 competitions, 10 requests a minute, delayed scores and schedules, standings;
 *   line-ups and goal scorers only on paid tiers (so `events`/`lineups` are reported as missing).
 * - The pricing page does not state commercial-use or attribution terms; ask the provider before a
 *   commercial launch (see docs/COST_AND_SERVICES.md). We show the source on every page anyway.
 */
export const FOOTBALL_DATA_INFO: ProviderInfo = {
  id: 'football-data',
  name: 'football-data.org',
  homepage: 'https://www.football-data.org/',
  attribution: null,
  capabilities: { dateRange: true, competitions: true, standings: true, teamMatches: true, events: false, lineups: false, stats: false, realtimeScores: false },
  coverageNote: 'Free plan: 12 major competitions, scores and schedules are delayed, no line-ups or match events.',
  testData: false,
};

const BASE = 'https://api.football-data.org/v4';
type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function team(raw: unknown): TeamRef | null {
  const t = obj(raw);
  const id = t ? toInt(t.id) : null;
  const name = t ? str(t.shortName) ?? str(t.name) : null;
  if (!t || id === null || !name) return null;
  return { id: String(id), name, logoUrl: httpsUrl(t.crest) };
}

function competition(raw: unknown, area?: unknown): CompetitionRef {
  const c = obj(raw);
  const a = obj(area) ?? (c ? obj(c.area) : null);
  const code = c ? str(c.code) : null;
  const id = c ? toInt(c.id) : null;
  return { id: code ?? (id !== null ? String(id) : null), name: (c && str(c.name)) ?? 'Unknown competition', logoUrl: c ? httpsUrl(c.emblem) : null, area: a ? str(a.name) : null };
}

export function normaliseFootballDataMatch(raw: unknown): Match | null {
  const m = obj(raw);
  if (!m) return null;
  const id = toInt(m.id);
  const kickoff = toIsoUtc(m.utcDate);
  const home = team(m.homeTeam);
  const away = team(m.awayTeam);
  // Knock-out fixtures can have undecided teams; they are not shown until both are known.
  if (id === null || !kickoff || !home || !away) return null;
  const score = obj(m.score);
  const full = score ? obj(score.fullTime) : null;
  const half = score ? obj(score.halfTime) : null;
  const status = footballDataStatus(m.status);
  const halftime = half && (half.home !== null || half.away !== null) ? { home: toInt(half.home), away: toInt(half.away) } : null;
  return {
    id: String(id),
    provider: 'football-data',
    kickoff,
    status,
    statusText: str(m.status),
    minute: toInt(m.minute),
    competition: competition(m.competition, m.area),
    home,
    away,
    score: { home: full ? toInt(full.home) : null, away: full ? toInt(full.away) : null },
    halftime,
    sourceUrl: null,
  };
}

function goals(m: Raw, home: TeamRef): MatchEvent[] | null {
  if (!Array.isArray(m.goals)) return null;
  return m.goals.map((g): MatchEvent | null => {
    const o = obj(g);
    if (!o) return null;
    const t = obj(o.team);
    const sc = obj(o.score);
    const kind = str(o.type);
    return {
      minute: toInt(o.minute),
      type: kind === 'OWN' ? 'own_goal' : kind === 'PENALTY' ? 'penalty_goal' : 'goal',
      label: kind === 'OWN' ? 'Own goal' : kind === 'PENALTY' ? 'Penalty goal' : 'Goal',
      side: t ? (String(toInt(t.id)) === home.id ? 'home' : 'away') : null,
      player: (obj(o.scorer) && str(obj(o.scorer)!.name)) ?? null,
      score: sc && toInt(sc.home) !== null && toInt(sc.away) !== null ? { home: toInt(sc.home)!, away: toInt(sc.away)! } : null,
    };
  }).filter((e): e is MatchEvent => e !== null);
}

export class FootballDataProvider implements FootballProvider {
  readonly info = FOOTBALL_DATA_INFO;

  constructor(private readonly apiKey: string, private readonly http: HttpOptions = {}) {
    if (!apiKey) throw new ProviderError('not_configured', 'FOOTBALL_DATA_API_KEY is not set');
  }

  private get(path: string, signal?: AbortSignal) {
    // No retry on 5xx here: the free plan's 10 requests a minute are better spent later.
    return getJson(`${BASE}${path}`, { 'X-Auth-Token': this.apiKey }, { retries: 0, ...this.http }, signal);
  }

  async matches(from: string, to: string, signal?: AbortSignal): Promise<Match[]> {
    // dateTo is exclusive in practice for some plans; ask for one extra day and let the caller filter.
    const end = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const body = obj(await this.get(`/matches?dateFrom=${from}&dateTo=${end}`, signal));
    if (!body || !Array.isArray(body.matches)) throw new ProviderError('bad_response', 'matches list missing');
    return body.matches.map(normaliseFootballDataMatch).filter((m): m is Match => m !== null);
  }

  async match(id: string, signal?: AbortSignal): Promise<MatchDetail | null> {
    if (!/^\d{1,12}$/.test(id)) return null;
    const raw = obj(await this.get(`/matches/${id}`, signal));
    const m = raw ? (obj(raw.match) ?? raw) : null;
    const base = normaliseFootballDataMatch(m);
    if (!m || !base) return null;
    return { ...base, events: goals(m, base.home), lineups: null, stats: null };
  }

  async teamMatches(teamId: string, signal?: AbortSignal) {
    if (!/^\d{1,12}$/.test(teamId)) return null;
    const [info, list] = await Promise.all([this.get(`/teams/${teamId}`, signal), this.get(`/teams/${teamId}/matches?limit=20`, signal)]);
    const t = team(info);
    const body = obj(list);
    if (!t || !body || !Array.isArray(body.matches)) return null;
    return { team: t, matches: body.matches.map(normaliseFootballDataMatch).filter((m): m is Match => m !== null) };
  }

  async standings(competitionId: string, signal?: AbortSignal): Promise<Standings | null> {
    if (!/^[A-Z0-9]{2,10}$/.test(competitionId)) return null;
    const body = obj(await this.get(`/competitions/${competitionId}/standings`, signal));
    if (!body || !Array.isArray(body.standings)) return null;
    const season = obj(body.season);
    const groups = body.standings
      .map((s) => obj(s))
      .filter((s): s is Raw => s !== null && (s.type === 'TOTAL' || s.type === undefined))
      .map((s) => ({
        name: str(s.group)?.replace(/_/g, ' ') ?? null,
        rows: (Array.isArray(s.table) ? s.table : []).map((r): StandingRow | null => {
          const o = obj(r);
          const t = o ? team(o.team) : null;
          if (!o || !t) return null;
          const n = (v: unknown) => toInt(v) ?? 0;
          return {
            position: n(o.position), team: t, played: n(o.playedGames), won: n(o.won), drawn: n(o.draw), lost: n(o.lost),
            goalsFor: n(o.goalsFor), goalsAgainst: n(o.goalsAgainst), goalDifference: n(o.goalDifference), points: n(o.points), form: str(o.form),
          };
        }).filter((r): r is StandingRow => r !== null),
      }));
    const start = season ? str(season.startDate) : null;
    const end = season ? str(season.endDate) : null;
    return { competition: competition(body.competition, body.area), season: start && end ? `${start.slice(0, 4)}/${end.slice(0, 4)}` : null, groups };
  }

  async competitions(signal?: AbortSignal): Promise<CompetitionRef[]> {
    const body = obj(await this.get('/competitions?plan=TIER_ONE', signal));
    if (!body || !Array.isArray(body.competitions)) throw new ProviderError('bad_response', 'competition list missing');
    return body.competitions.map((c) => competition(c)).filter((c) => c.id !== null);
  }
}
