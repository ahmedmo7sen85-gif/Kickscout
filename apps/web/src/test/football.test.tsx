import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SourceLine } from '@/components/football/Football';
import {
  dayInZone, EMPTY_LOCAL, groupByCompetition, involves, isDay, readLocalFavorites, scoreText, shiftDay, toggleLocal, writeLocalFavorites,
} from '@/lib/football';
import { createI18nValue, I18nContext } from '@/lib/i18n/provider';
import { urlBase64ToUint8Array } from '@/lib/push';
import { matchJsonLd } from '@/lib/seo';
import type { FootballSource, MatchDetailResponse, MatchView } from '@/lib/types';

const team = (id: string, name: string) => ({ id, name, shortName: null, logoUrl: null });
const match = (over: Partial<MatchView> = {}): MatchView => ({
  id: 'm1', provider: 'sportscore', status: 'live', statusText: null, minute: 30, kickoff: '2026-10-25T18:00:00.000Z',
  home: team('h', 'Home FC'), away: team('a', 'Away FC'), score: { home: 1, away: 0 }, halftime: null,
  competition: { id: 'c1', name: 'League', area: null, logoUrl: null }, sourceUrl: null, ...over,
} as MatchView);

describe('football time helpers', () => {
  it('finds the calendar day in a zone, not in UTC', () => {
    const at = new Date('2026-10-25T23:30:00Z');
    expect(dayInZone(at, 'UTC')).toBe('2026-10-25');
    expect(dayInZone(at, 'Asia/Riyadh')).toBe('2026-10-26');
    expect(dayInZone(at, 'America/Sao_Paulo')).toBe('2026-10-25');
  });
  it('moves across month and year ends and validates days', () => {
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(isDay('2026-10-25')).toBe(true);
    expect(isDay('2026-13-40')).toBe(false);
    expect(isDay('25/10/2026')).toBe(false);
    expect(isDay(null)).toBe(false);
  });
});

describe('scores', () => {
  it('never shows 0–0 for a match that has not started', () => {
    expect(scoreText(match({ status: 'scheduled', score: { home: 0, away: 0 } }))).toBeNull();
    expect(scoreText(match({ status: 'postponed', score: { home: 0, away: 0 } }))).toBeNull();
    expect(scoreText(match({ score: { home: null, away: null } }))).toBeNull();
    expect(scoreText(match())).toBe('1–0');
  });
  it('groups by competition and marks followed matches', () => {
    const groups = groupByCompetition([match(), match({ id: 'm2', competition: { id: 'c2', name: 'Cup', area: null, logoUrl: null } }), match({ id: 'm3' })]);
    expect(groups.map((g) => [g.competition.name, g.matches.length])).toEqual([['League', 2], ['Cup', 1]]);
    expect(involves(match(), new Set(['a']), new Set())).toBe(true);
    expect(involves(match(), new Set(), new Set(['c1']))).toBe(true);
    expect(involves(match(), new Set(['x']), new Set(['y']))).toBe(false);
  });
});

describe('device-local favourites', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };
  it('round-trips, toggles, and starts over when the data source changes', () => {
    const s = store();
    let v = toggleLocal(EMPTY_LOCAL, 'team', team('h', 'Home FC'), 'sportscore');
    v = toggleLocal(v, 'competition', { id: 'c1', name: 'League', area: null, logoUrl: null }, 'sportscore');
    writeLocalFavorites(s, v);
    expect(readLocalFavorites(s)).toEqual(v);
    expect(toggleLocal(v, 'team', team('h', 'Home FC'), 'sportscore').teams).toEqual([]);
    const switched = toggleLocal(v, 'team', team('x', 'Other'), 'football-data');
    expect(switched).toMatchObject({ provider: 'football-data', teams: [{ id: 'x' }], competitions: [] });
    writeLocalFavorites(s, EMPTY_LOCAL);
    expect(s.m.size).toBe(0);
  });
  it('ignores corrupt or tampered storage', () => {
    expect(readLocalFavorites({ getItem: () => '{not json' })).toEqual(EMPTY_LOCAL);
    expect(readLocalFavorites({ getItem: () => JSON.stringify({ provider: 1, teams: [{ id: 5 }, { id: 'ok', name: 'OK' }], competitions: 'x' }) }))
      .toEqual({ provider: null, teams: [{ id: 'ok', name: 'OK' }], competitions: [] });
    expect(readLocalFavorites({ getItem: () => { throw new Error('blocked'); } })).toEqual(EMPTY_LOCAL);
    expect(readLocalFavorites(null)).toEqual(EMPTY_LOCAL);
  });
});

describe('source line', () => {
  const source: FootballSource = {
    provider: 'sportscore', name: 'SportScore', homepage: 'https://sportscore.com', attribution: { text: 'Powered by SportScore', url: 'https://sportscore.com/' },
    testData: false, coverageNote: '', fetchedAt: '2026-10-25T18:00:00.000Z', stale: false,
    capabilities: { dateRange: false, competitions: false, standings: false, lineups: false, events: true, stats: true, teamMatches: true, realtimeScores: false },
  } as FootballSource;
  const render = (s: FootballSource, locale = 'en') => renderToStaticMarkup(
    <I18nContext.Provider value={createI18nValue(locale as 'en' | 'ar')}><SourceLine source={s} /></I18nContext.Provider>,
  );
  it('always shows the provider attribution as a followed link', () => {
    const html = render(source);
    expect(html).toContain('Powered by SportScore');
    expect(html).toContain('href="https://sportscore.com/"');
    expect(html).not.toContain('nofollow');
    expect(html).toContain('Data: SportScore');
    expect(html).not.toContain('stale-notice');
  });
  it('labels stale data and invented test data', () => {
    expect(render({ ...source, stale: true })).toContain('data-testid="stale-notice"');
    expect(render({ ...source, testData: true })).toContain('Test data');
    expect(render(source, 'ar')).toContain('Powered by SportScore');
  });
});

describe('push and structured data', () => {
  it('decodes URL-safe VAPID keys', () => {
    expect([...urlBase64ToUint8Array('AQID_-8')]).toEqual([1, 2, 3, 255, 239]);
  });
  it('builds SportsEvent data without inventing fields', () => {
    const r = { match: { ...match({ status: 'scheduled', score: { home: null, away: null } }), events: null, lineups: null, stats: null }, source: {} } as unknown as MatchDetailResponse;
    const ld = matchJsonLd(r, 'https://k.test');
    expect(ld).toMatchObject({ '@type': 'SportsEvent', name: 'Home FC v Away FC', startDate: '2026-10-25T18:00:00.000Z', eventStatus: 'https://schema.org/EventScheduled', url: 'https://k.test/scores/match/m1' });
    expect(Object.keys(ld)).not.toContain('score');
    expect(JSON.stringify(ld)).not.toMatch(/"(homeScore|awayScore|score)"/);
  });
});
