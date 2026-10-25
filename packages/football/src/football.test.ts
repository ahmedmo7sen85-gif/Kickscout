import { describe, expect, it } from 'vitest';
import {
  addDays, dayIn, detectAlerts, FixtureProvider, FootballDataProvider, footballDataStatus, freshForSeconds, isValidTimeZone, localDayRange,
  normaliseFootballDataMatch, normaliseSportscoreDetail, normaliseSportscoreMatch, ProviderError, snapshotOf, SportScoreProvider,
  sportscoreStatus, utcDaysCovering, alertMessage, type Match,
} from './index.js';

// Copied from a real SportScore response (GET /api/widget/matches/?sport=football, 2026-10-25).
const SS_MATCH = {
  home: 'Santos FC - SP', away: 'Bahia - BA',
  home_logo: 'https://img.thesports.com/football/team/0840bace9b911b3f0dbadb710ea20316.png',
  away_logo: 'https://img.thesports.com/football/team/20456802ad5f8243dc282c4650c414e1.png',
  home_score: '1', away_score: '1', status: 'finished', status_text: 'Finished', time: '2026-10-25T00:00:00+00:00',
  competition: 'Brazilian Serie A', competition_logo: 'https://img.thesports.com/football/competition/5ad7bd885c64690f15f6971a2827190d.png',
  url: '/football/match/bahia-vs-santos/4jwq2ghnz4p1m0v/',
};
// Trimmed from the real match-detail response for the same fixture.
const SS_DETAIL = {
  ...SS_MATCH, live_minute: null,
  incidents: [
    { time: 31, type: 'Yellow card', type_id: 3, side: 'home', player: 'Neymar da Silva Santos Júnior', is_card: true },
    { time: 39, type: 'Goal', type_id: 1, side: 'away', player: 'Luciano', is_goal: true, home_score: 0, away_score: 1 },
  ],
  stats: [],
  lineups: {
    home_formation: '4-2-3-1', away_formation: '4-3-3', home_coach: null, away_coach: null, confirmed: true,
    home_xi: [{ name: 'Diogenes', number: 1, position: 'G', captain: false, rating: '0.0' }], home_subs: [],
    away_xi: [{ name: 'Nicolas Acevedo', number: 5, position: 'M', captain: true, rating: '0.0' }], away_subs: [],
  },
  home_ht_score: 0, away_ht_score: 1,
};

function fakeFetch(routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>, log: string[] = []) {
  return async (url: string) => {
    log.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key]! : { status: 404, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  };
}

describe('status mapping', () => {
  it('maps SportScore values seen in real responses and refuses to guess the rest', () => {
    expect(sportscoreStatus('finished', 'Finished')).toBe('finished');
    expect(sportscoreStatus('upcoming', 'Delayed')).toBe('scheduled');
    expect(sportscoreStatus('live', 'Halftime')).toBe('halftime');
    expect(sportscoreStatus('upcoming', 'Postponed')).toBe('postponed');
    expect(sportscoreStatus('something-new', 'Who knows')).toBe('unknown');
  });
  it('maps every football-data.org status', () => {
    expect(['SCHEDULED', 'TIMED', 'IN_PLAY', 'PAUSED', 'FINISHED', 'AWARDED', 'POSTPONED', 'SUSPENDED', 'CANCELLED', 'X'].map(footballDataStatus))
      .toEqual(['scheduled', 'scheduled', 'live', 'halftime', 'finished', 'finished', 'postponed', 'suspended', 'cancelled', 'unknown']);
  });
});

describe('SportScore adapter', () => {
  it('normalises a list match with a provider-scoped id and source link', () => {
    const m = normaliseSportscoreMatch(SS_MATCH)!;
    expect(m).toMatchObject({
      id: 'bahia-vs-santos~4jwq2ghnz4p1m0v', status: 'finished', score: { home: 1, away: 1 }, kickoff: '2026-10-25T00:00:00.000Z',
      home: { id: 'santos-fc-sp', name: 'Santos FC - SP' }, competition: { name: 'Brazilian Serie A', id: 'brazilian-serie-a' },
      sourceUrl: 'https://sportscore.com/football/match/bahia-vs-santos/4jwq2ghnz4p1m0v/',
    });
  });
  it('skips malformed entries instead of inventing fields', () => {
    expect(normaliseSportscoreMatch({ ...SS_MATCH, url: 'javascript:alert(1)' })).toBeNull();
    expect(normaliseSportscoreMatch({ ...SS_MATCH, time: 'soon' })).toBeNull();
    expect(normaliseSportscoreMatch({ ...SS_MATCH, home_logo: 'http://insecure/x.png' })!.home.logoUrl).toBeNull();
  });
  it('normalises events, line-ups and half-time; empty stats mean unavailable', () => {
    const d = normaliseSportscoreDetail(SS_DETAIL)!;
    expect(d.events).toEqual([
      { minute: 31, type: 'yellow_card', label: 'Yellow card', side: 'home', player: 'Neymar da Silva Santos Júnior', score: null },
      { minute: 39, type: 'goal', label: 'Goal', side: 'away', player: 'Luciano', score: { home: 0, away: 1 } },
    ]);
    expect(d.lineups?.confirmed).toBe(true);
    expect(d.lineups?.away.startingXI[0]).toEqual({ name: 'Nicolas Acevedo', number: 5, position: 'M', captain: true });
    expect(d.halftime).toEqual({ home: 0, away: 1 });
    expect(d.stats).toBeNull();
  });
  it('refuses a detail whose slug resolved to a different fixture', async () => {
    const p = new SportScoreProvider({ fetchImpl: fakeFetch({ '/api/widget/match/': { body: { match: { ...SS_DETAIL, url: '/football/match/bahia-vs-santos/zzzzzzzzzz/' } } } }) });
    expect(await p.match('bahia-vs-santos~4jwq2ghnz4p1m0v')).toBeNull();
    const ok = new SportScoreProvider({ fetchImpl: fakeFetch({ '/api/widget/match/': { body: { match: SS_DETAIL } } }) });
    expect((await ok.match('bahia-vs-santos~4jwq2ghnz4p1m0v'))?.id).toBe('bahia-vs-santos~4jwq2ghnz4p1m0v');
  });
  it('refuses a team endpoint answer for another club with a similar slug', async () => {
    // Real behaviour seen 2026-10-25: slug "barcelona" returned Barcelona (Ecuador)'s Chilean Cup game.
    const p = new SportScoreProvider({ fetchImpl: fakeFetch({ '/api/widget/team/': { body: { team: { name: 'Barcelona SC', slug: 'barcelona-sc' }, matches: [SS_MATCH] } } }) });
    expect(await p.teamMatches('barcelona')).toBeNull();
  });
  it('turns 429 into a rate-limit error with the provider’s Retry-After', async () => {
    const p = new SportScoreProvider({ retries: 0, fetchImpl: fakeFetch({ '/matches/': { status: 429, headers: { 'retry-after': '120' } } }) });
    await expect(p.matches('', '')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 120 });
  });
  it('retries once after a 5xx, then reports the provider as unavailable', async () => {
    const log: string[] = [];
    const p = new SportScoreProvider({ fetchImpl: fakeFetch({ '/matches/': { status: 502 } }, log) });
    await expect(p.matches('', '')).rejects.toBeInstanceOf(ProviderError);
    expect(log).toHaveLength(2);
    expect(log[0]).toContain('sport=football');
  });
  it('declares standings unsupported rather than returning an empty table', async () => {
    await expect(new SportScoreProvider().standings()).rejects.toMatchObject({ kind: 'not_supported' });
  });
});

describe('football-data.org adapter', () => {
  // Shape from the v4 documentation (https://docs.football-data.org/general/v4/match.html).
  const FD = {
    id: 497000, utcDate: '2026-10-25T15:00:00Z', status: 'IN_PLAY', minute: 63,
    competition: { id: 2021, name: 'Premier League', code: 'PL', emblem: 'https://crests.football-data.org/PL.png' },
    area: { name: 'England' },
    homeTeam: { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', crest: 'https://crests.football-data.org/57.png' },
    awayTeam: { id: 61, name: 'Chelsea FC', shortName: 'Chelsea', crest: 'https://crests.football-data.org/61.png' },
    score: { fullTime: { home: 2, away: 1 }, halfTime: { home: 1, away: 1 } },
  };
  it('normalises a match', () => {
    expect(normaliseFootballDataMatch(FD)).toMatchObject({
      id: '497000', status: 'live', minute: 63, home: { id: '57', name: 'Arsenal' }, away: { id: '61' },
      competition: { id: 'PL', area: 'England' }, score: { home: 2, away: 1 }, halftime: { home: 1, away: 1 },
    });
    expect(normaliseFootballDataMatch({ ...FD, awayTeam: { id: null, name: null } })).toBeNull();
  });
  it('sends the key only as a header and never without one', async () => {
    expect(() => new FootballDataProvider('')).toThrow(ProviderError);
    const seen: RequestInit[] = [];
    const p = new FootballDataProvider('secret-key', { fetchImpl: async (url, init) => { seen.push(init!); expect(url).not.toContain('secret-key'); return new Response(JSON.stringify({ matches: [FD] })); } });
    expect(await p.matches('2026-10-25', '2026-10-25')).toHaveLength(1);
    expect((seen[0]!.headers as Record<string, string>)['X-Auth-Token']).toBe('secret-key');
  });
  it('maps standings', async () => {
    const body = { competition: FD.competition, season: { startDate: '2026-08-14', endDate: '2027-05-23' }, standings: [{ type: 'TOTAL', table: [
      { position: 1, team: FD.homeTeam, playedGames: 9, won: 7, draw: 1, lost: 1, points: 22, goalsFor: 20, goalsAgainst: 7, goalDifference: 13, form: 'W,W,D' },
    ] }, { type: 'HOME', table: [] }] };
    const p = new FootballDataProvider('k', { fetchImpl: async () => new Response(JSON.stringify(body)) });
    const s = (await p.standings('PL'))!;
    expect(s.season).toBe('2026/2027');
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]!.rows[0]).toMatchObject({ position: 1, team: { name: 'Arsenal' }, points: 22, drawn: 1 });
  });
});

describe('time zones', () => {
  it('validates zones and days', () => {
    expect(isValidTimeZone('Africa/Cairo')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
  it('gives a 25-hour local day when clocks go back (London, 2026-10-25)', () => {
    const { start, end } = localDayRange('2026-10-25', 'Europe/London');
    expect(start.toISOString()).toBe('2026-10-24T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(utcDaysCovering(start, end)).toEqual(['2026-10-24', '2026-10-25']);
  });
  it('handles zones east and west of UTC', () => {
    expect(localDayRange('2026-07-01', 'Africa/Cairo').start.toISOString()).toBe('2026-06-30T21:00:00.000Z');
    expect(localDayRange('2026-07-01', 'America/New_York').start.toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(dayIn(new Date('2026-07-01T02:00:00Z'), 'America/New_York')).toBe('2026-06-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('alert detection', () => {
  const now = new Date('2026-10-25T15:00:00Z');
  const base: Match = normaliseFootballDataMatch({
    id: 1, utcDate: '2026-10-25T15:00:00Z', status: 'TIMED', competition: { id: 1, name: 'L', code: 'PL' },
    homeTeam: { id: 1, name: 'A' }, awayTeam: { id: 2, name: 'B' }, score: { fullTime: { home: null, away: null } },
  })!;
  const at = (patch: Partial<Match>): Match => ({ ...base, ...patch });

  it('never reports a first sighting as news (no fake goals after a restart)', () => {
    expect(detectAlerts(null, at({ status: 'live', score: { home: 2, away: 0 } }), now)).toEqual([]);
  });
  it('reports kickoff, each goal, half-time and full-time from real transitions', () => {
    const s0 = snapshotOf(base, false);
    expect(detectAlerts(s0, at({ status: 'live', score: { home: 0, away: 0 } }), now).map((a) => a.category)).toEqual(['kickoff']);
    const live = snapshotOf(at({ status: 'live', score: { home: 0, away: 0 } }), false);
    const goal = detectAlerts(live, at({ status: 'live', score: { home: 1, away: 0 } }), now);
    expect(goal.map((a) => a.key)).toEqual(['football-data:1:goal:1-0']);
    const ht = snapshotOf(at({ status: 'live', score: { home: 1, away: 0 } }), false);
    expect(detectAlerts(ht, at({ status: 'halftime', score: { home: 1, away: 0 } }), now).map((a) => a.category)).toEqual(['halftime']);
    expect(detectAlerts(ht, at({ status: 'finished', score: { home: 1, away: 0 } }), now).map((a) => a.category)).toEqual(['final_result']);
  });
  it('does not alert for a disallowed goal or for kickoff time passing', () => {
    const one = snapshotOf(at({ status: 'live', score: { home: 1, away: 0 } }), false);
    expect(detectAlerts(one, at({ status: 'live', score: { home: 0, away: 0 } }), now)).toEqual([]);
    const sched = snapshotOf(base, false);
    expect(detectAlerts(sched, at({ status: 'scheduled' }), new Date('2026-10-25T16:00:00Z'))).toEqual([]);
  });
  it('announces "starting soon" inside 30 minutes, keyed by kickoff so a reschedule re-announces', () => {
    const a = detectAlerts(null, base, new Date('2026-10-25T14:40:00Z'));
    expect(a.map((x) => x.key)).toEqual(['football-data:1:starting_soon:2026-10-25T15:00:00.000Z']);
    expect(detectAlerts(null, base, new Date('2026-10-25T14:00:00Z'))).toEqual([]);
  });
  it('announces confirmed line-ups once', () => {
    expect(detectAlerts(null, base, new Date('2026-10-25T14:00:00Z'), true).map((a) => a.category)).toEqual(['lineups']);
    expect(detectAlerts(snapshotOf(base, true), base, new Date('2026-10-25T14:00:00Z'), true)).toEqual([]);
  });
  it('writes short English and Arabic messages', () => {
    const a = detectAlerts(snapshotOf(at({ status: 'live', score: { home: 0, away: 0 } }), false), at({ status: 'live', score: { home: 1, away: 0 } }), now)[0]!;
    expect(alertMessage(a)).toEqual({ title: 'Goal!', body: 'A 1–0 B' });
    expect(alertMessage(a, 'ar').title).toBe('هدف!');
  });
});

describe('cache freshness', () => {
  it('refreshes live data every minute and old results rarely', () => {
    expect(freshForSeconds('matches', { matches: [{ status: 'live' }], day: '2026-10-25', today: '2026-10-25' })).toBe(60);
    expect(freshForSeconds('matches', { matches: [], day: '2026-10-20', today: '2026-10-25' })).toBe(6 * 3600);
    expect(freshForSeconds('match', { status: 'finished' })).toBe(24 * 3600);
  });
});

describe('fixture provider', () => {
  it('is labelled as test data and supports state changes', async () => {
    const p = new FixtureProvider(() => new Date('2026-10-25T15:00:00Z'));
    expect(p.info.testData).toBe(true);
    p.set('fx-4', { status: 'live', score: { home: 0, away: 0 } });
    const all = await p.matches('2026-10-25', '2026-10-25');
    expect(all.find((m) => m.id === 'fx-4')?.status).toBe('live');
  });
});
