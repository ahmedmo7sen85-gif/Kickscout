import { getJson, httpsUrl, slugify, toInt, toIsoUtc, type HttpOptions } from './http.js';
import { sportscoreEventType, sportscoreStatus } from './status.js';
import type { CompetitionRef, FootballProvider, LineupPlayer, Match, MatchDetail, MatchEvent, ProviderInfo, TeamLineup, TeamRef } from './types.js';
import { ProviderError } from './types.js';

/**
 * SportScore public widget API (https://sportscore.com/developers/), checked 2026-10-25.
 *
 * - No key on the free tier; about 10,000 requests a day per IP; responses edge-cached for 60 s.
 * - Terms: a visible, crawlable "Powered by SportScore" link to https://sportscore.com/ on every
 *   page that shows the data; no bulk redistribution; caching on our side is allowed.
 * - Coverage is a window of live and recent matches (at most 50 per call), with no date filter,
 *   no competition list and no documented competition slugs, so standings are not offered here.
 * - Matches carry no team ids, only names; team pages use the team endpoint by slug and are
 *   offered only when the slug resolves to the same team name.
 */
export const SPORTSCORE_INFO: ProviderInfo = {
  id: 'sportscore',
  name: 'SportScore',
  homepage: 'https://sportscore.com/',
  attribution: { text: 'Powered by SportScore', url: 'https://sportscore.com/' },
  capabilities: { dateRange: false, competitions: false, standings: false, teamMatches: true, events: true, lineups: true, stats: true, realtimeScores: true },
  coverageNote: 'Live and recent matches only (up to 50 at a time). Browsing other dates, standings and full competition lists are not available from this source.',
  testData: false,
};

const BASE = 'https://sportscore.com';
const MATCH_URL = /^\/football\/match\/([a-z0-9-]{1,120})\/([a-z0-9]{6,40})\/?$/;
const MATCH_ID = /^([a-z0-9-]{1,120})~([a-z0-9]{6,40})$/;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function team(name: string, logo: unknown): TeamRef {
  return { id: slugify(name), name, logoUrl: httpsUrl(logo) };
}

function competition(name: string | null, logo: unknown): CompetitionRef {
  const n = name ?? 'Unknown competition';
  return { id: name ? slugify(name) : null, name: n, logoUrl: httpsUrl(logo), area: null };
}

/** One SportScore match object to our model; null when it lacks what a match needs (it is skipped). */
export function normaliseSportscoreMatch(raw: unknown): Match | null {
  const m = obj(raw);
  if (!m) return null;
  const url = str(m.url);
  const parts = url ? MATCH_URL.exec(url) : null;
  const home = str(m.home);
  const away = str(m.away);
  const kickoff = toIsoUtc(m.time);
  if (!parts || !home || !away || !kickoff) return null;
  const hasHt = m.home_ht_score !== undefined || m.away_ht_score !== undefined;
  return {
    id: `${parts[1]}~${parts[2]}`,
    provider: 'sportscore',
    kickoff,
    status: sportscoreStatus(m.status, m.status_text),
    statusText: str(m.status_text),
    minute: toInt(m.live_minute),
    competition: competition(str(m.competition), m.competition_logo),
    home: team(home, m.home_logo),
    away: team(away, m.away_logo),
    score: { home: toInt(m.home_score), away: toInt(m.away_score) },
    halftime: hasHt ? { home: toInt(m.home_ht_score), away: toInt(m.away_ht_score) } : null,
    sourceUrl: `${BASE}${url}`,
  };
}

function player(raw: unknown): LineupPlayer | null {
  const p = obj(raw);
  const name = p ? str(p.name) : null;
  if (!p || !name) return null;
  return { name, number: toInt(p.number), position: str(p.position), captain: p.captain === true };
}

function players(raw: unknown): LineupPlayer[] {
  return Array.isArray(raw) ? raw.map(player).filter((p): p is LineupPlayer => p !== null) : [];
}

function lineup(l: Raw, side: 'home' | 'away'): TeamLineup {
  return { formation: str(l[`${side}_formation`]), coach: str(l[`${side}_coach`]), startingXI: players(l[`${side}_xi`]), substitutes: players(l[`${side}_subs`]) };
}

function event(raw: unknown): MatchEvent | null {
  const e = obj(raw);
  if (!e) return null;
  const label = str(e.type) ?? 'Event';
  const side = e.side === 'home' || e.side === 'away' ? e.side : null;
  const hs = toInt(e.home_score);
  const as = toInt(e.away_score);
  return {
    minute: toInt(e.time),
    type: sportscoreEventType(label, e.type_id, e.is_goal, e.is_card),
    label,
    side,
    player: str(e.player),
    score: hs !== null && as !== null ? { home: hs, away: as } : null,
  };
}

/** SportScore match detail to our model. */
export function normaliseSportscoreDetail(raw: unknown): MatchDetail | null {
  const m = obj(raw);
  const base = normaliseSportscoreMatch(m);
  if (!m || !base) return null;
  const l = obj(m.lineups);
  const hasLineups = l && (Array.isArray(l.home_xi) || Array.isArray(l.away_xi));
  const statsRaw = Array.isArray(m.stats) ? m.stats : null;
  const stats = statsRaw
    ? statsRaw.map((s) => {
        const o = obj(s);
        const label = o ? str(o.name) ?? str(o.label) ?? str(o.type) : null;
        if (!o || !label) return null;
        const v = (x: unknown) => (typeof x === 'number' ? String(x) : str(x));
        return { label, home: v(o.home), away: v(o.away) };
      }).filter((s): s is NonNullable<typeof s> => s !== null)
    : null;
  return {
    ...base,
    events: Array.isArray(m.incidents) ? m.incidents.map(event).filter((e): e is MatchEvent => e !== null) : null,
    lineups: hasLineups && l ? { confirmed: l.confirmed === true, home: lineup(l, 'home'), away: lineup(l, 'away') } : null,
    // An empty array from SportScore means "no stats for this match", which we report as unavailable.
    stats: stats && stats.length ? stats : null,
  };
}

export class SportScoreProvider implements FootballProvider {
  readonly info = SPORTSCORE_INFO;

  constructor(private readonly http: HttpOptions & { appName?: string } = {}) {}

  private url(path: string, params: Record<string, string | number>) {
    const q = new URLSearchParams({ sport: 'football', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
    // `src` names the app in SportScore's own analytics (their docs ask for it); nothing about users is sent.
    if (this.http.appName) q.set('src', this.http.appName);
    return `${BASE}${path}?${q.toString()}`;
  }

  private get(path: string, params: Record<string, string | number>, signal?: AbortSignal) {
    return getJson(this.url(path, params), {}, { userAgent: 'KICKSCOUT (+https://kickscout-ten.vercel.app)', ...this.http }, signal);
  }

  /** The live/recent window; the date arguments are ignored (no date filter exists) and the caller filters. */
  async matches(_from: string, _to: string, signal?: AbortSignal): Promise<Match[]> {
    const body = obj(await this.get('/api/widget/matches/', { limit: 50 }, signal));
    if (!body || !Array.isArray(body.matches)) throw new ProviderError('bad_response', 'matches list missing');
    return body.matches.map(normaliseSportscoreMatch).filter((m): m is Match => m !== null);
  }

  async match(id: string, signal?: AbortSignal): Promise<MatchDetail | null> {
    const parts = MATCH_ID.exec(id);
    if (!parts) return null;
    const body = obj(await this.get('/api/widget/match/', { slug: parts[1]! }, signal));
    if (!body) return null;
    const detail = normaliseSportscoreDetail(body.match);
    // The endpoint looks matches up by slug; a slug can name another fixture between the same
    // clubs, so anything but the exact match id is treated as not found rather than shown.
    return detail && detail.id === id ? detail : null;
  }

  async teamMatches(teamId: string, signal?: AbortSignal) {
    if (!/^[a-z0-9-]{1,80}$/.test(teamId)) return null;
    const body = obj(await this.get('/api/widget/team/', { slug: teamId, limit: 20 }, signal));
    const t = body ? obj(body.team) : null;
    const name = t ? str(t.name) : null;
    if (!body || !t || !name) return null;
    // Names are the only link between list matches and teams; refuse a different club with a similar slug.
    if (slugify(name) !== teamId && str(t.slug) !== teamId) return null;
    const matches = Array.isArray(body.matches) ? body.matches.map(normaliseSportscoreMatch).filter((m): m is Match => m !== null) : [];
    return { team: { id: teamId, name, logoUrl: httpsUrl(t.logo) }, matches };
  }

  async standings(): Promise<null> {
    throw new ProviderError('not_supported', 'standings are not available from SportScore without documented competition slugs');
  }

  async competitions(signal?: AbortSignal): Promise<CompetitionRef[]> {
    const seen = new Map<string, CompetitionRef>();
    for (const m of await this.matches('', '', signal)) if (m.competition.id) seen.set(m.competition.id, m.competition);
    return [...seen.values()];
  }
}
