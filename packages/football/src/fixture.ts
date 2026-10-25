import type { CompetitionRef, FootballProvider, Match, MatchDetail, ProviderInfo, Standings, TeamRef } from './types.js';

/**
 * Built-in test data for automated tests and local development without network access. Every page
 * that shows it carries a "Test data, not real matches" label (`testData: true`), and the API
 * refuses to use it in production. Team and competition names are invented on purpose.
 */
export const FIXTURE_INFO: ProviderInfo = {
  id: 'fixture',
  name: 'Test fixtures',
  homepage: 'https://github.com/ahmedmo7sen85-gif/kickscout',
  attribution: null,
  capabilities: { dateRange: true, competitions: true, standings: true, teamMatches: true, events: true, lineups: true, stats: false, realtimeScores: true },
  coverageNote: 'Invented test data for development. These are not real matches.',
  testData: true,
};

const comp = (id: string, name: string): CompetitionRef => ({ id, name, logoUrl: null, area: 'Testland' });
const team = (id: string, name: string): TeamRef => ({ id, name, logoUrl: null });

export const FIXTURE_COMPETITIONS = [comp('TL1', 'Test League One'), comp('TCUP', 'Test Cup')];
export const FIXTURE_TEAMS = [
  team('t-river', 'River Test FC'), team('t-harbour', 'Harbour Athletic'), team('t-north', 'North Park United'),
  team('t-valley', 'Valley Rovers'), team('t-city', 'Test City'), team('t-dunes', 'Dunes SC'),
];

function at(base: Date, minutes: number) {
  return new Date(base.getTime() + minutes * 60_000).toISOString();
}

/** A small day of football around `now`: one finished, one live, one at half-time, two upcoming, one postponed. */
export function fixtureMatches(now: Date): Match[] {
  const [l1, cup] = FIXTURE_COMPETITIONS as [CompetitionRef, CompetitionRef];
  const [a, b, c, d, e, f] = FIXTURE_TEAMS as [TeamRef, TeamRef, TeamRef, TeamRef, TeamRef, TeamRef];
  const m = (id: string, mins: number, status: Match['status'], competition: CompetitionRef, home: TeamRef, away: TeamRef, score: [number | null, number | null], minute: number | null = null): Match => ({
    id, provider: 'fixture', kickoff: at(now, mins), status, statusText: null, minute, competition, home, away,
    score: { home: score[0], away: score[1] }, halftime: null, sourceUrl: null,
  });
  return [
    m('fx-1', -150, 'finished', l1, a, b, [2, 1]),
    m('fx-2', -30, 'live', l1, c, d, [1, 0], 30),
    m('fx-3', -50, 'halftime', cup, e, f, [0, 0]),
    m('fx-4', 20, 'scheduled', l1, b, c, [null, null]),
    m('fx-5', 180, 'scheduled', cup, d, a, [null, null]),
    m('fx-6', 60, 'postponed', l1, f, e, [null, null]),
  ];
}

export class FixtureProvider implements FootballProvider {
  readonly info = FIXTURE_INFO;
  private overrides = new Map<string, Partial<Match>>();
  /** Calls made, for tests that check caching. */
  calls = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Tests move a match through states (kickoff, goal, final) to exercise alert detection. */
  set(id: string, patch: Partial<Match>) {
    this.overrides.set(id, { ...this.overrides.get(id), ...patch });
  }

  private all(): Match[] {
    return fixtureMatches(this.now()).map((m) => ({ ...m, ...this.overrides.get(m.id) }));
  }

  async matches(from: string, to: string): Promise<Match[]> {
    this.calls++;
    return this.all().filter((m) => m.kickoff.slice(0, 10) >= from && m.kickoff.slice(0, 10) <= to);
  }

  async match(id: string): Promise<MatchDetail | null> {
    this.calls++;
    const m = this.all().find((x) => x.id === id);
    if (!m) return null;
    const goals = m.score.home ?? 0;
    return {
      ...m,
      events: Array.from({ length: goals }, (_, i) => ({ minute: 10 + i * 10, type: 'goal' as const, label: 'Goal', side: 'home' as const, player: `Test Player ${i + 1}`, score: { home: i + 1, away: 0 } })),
      // Line-ups appear about an hour before kickoff, as with real providers.
      lineups: Date.parse(m.kickoff) - this.now().getTime() > 60 * 60_000 ? null : {
        confirmed: true,
        home: { formation: '4-3-3', coach: null, startingXI: [{ name: 'Test Keeper', number: 1, position: 'G', captain: false }], substitutes: [] },
        away: { formation: '4-4-2', coach: null, startingXI: [{ name: 'Test Goalie', number: 1, position: 'G', captain: true }], substitutes: [] },
      },
      stats: null,
    };
  }

  async teamMatches(teamId: string) {
    this.calls++;
    const t = FIXTURE_TEAMS.find((x) => x.id === teamId);
    return t ? { team: t, matches: this.all().filter((m) => m.home.id === teamId || m.away.id === teamId) } : null;
  }

  async standings(competitionId: string): Promise<Standings | null> {
    this.calls++;
    const c = FIXTURE_COMPETITIONS.find((x) => x.id === competitionId);
    if (!c) return null;
    const rows = FIXTURE_TEAMS.map((t, i) => ({
      position: i + 1, team: t, played: 10, won: 6 - i, drawn: 2, lost: 2 + i, goalsFor: 20 - i, goalsAgainst: 10 + i, goalDifference: 10 - 2 * i, points: 3 * (6 - i) + 2, form: null,
    }));
    return { competition: c, season: '2026/2027', groups: [{ name: null, rows }] };
  }

  async competitions() {
    this.calls++;
    return FIXTURE_COMPETITIONS;
  }
}
