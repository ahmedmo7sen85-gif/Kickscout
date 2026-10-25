/**
 * KICKSCOUT's own football model. Every provider adapter turns its responses into these types, so
 * the API and the web app never see a provider's field names and a provider can be swapped.
 *
 * Times are ISO 8601 in UTC. Anything a provider does not supply is `null` (never guessed), and
 * list fields that the provider cannot supply at all are `null` rather than `[]`, so the UI can say
 * "not available from this source" instead of "nothing happened".
 */

export type ProviderId = 'sportscore' | 'football-data' | 'fixture';

/**
 * Normalised match state. `unknown` is used for any provider value we cannot map with certainty; it
 * is never shown as live. A match is live only when the provider says so, never because its
 * kickoff time has passed.
 */
export const MATCH_STATUSES = ['scheduled', 'live', 'halftime', 'finished', 'postponed', 'suspended', 'cancelled', 'abandoned', 'unknown'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** In play for filters and alerts: live or at half-time. */
export const IN_PLAY: readonly MatchStatus[] = ['live', 'halftime'];

export interface TeamRef {
  /** Provider-scoped id, URL-safe. */
  id: string;
  name: string;
  logoUrl: string | null;
}

export interface CompetitionRef {
  /** Provider-scoped id, URL-safe; null when the provider only gives a name. */
  id: string | null;
  name: string;
  logoUrl: string | null;
  area: string | null;
}

export interface Score {
  home: number | null;
  away: number | null;
}

export interface Match {
  id: string;
  provider: ProviderId;
  kickoff: string;
  status: MatchStatus;
  /** The provider's own wording ("Delayed", "2nd half"), shown next to the normalised state. */
  statusText: string | null;
  /** Current minute when the provider supplies it. */
  minute: number | null;
  competition: CompetitionRef;
  home: TeamRef;
  away: TeamRef;
  score: Score;
  halftime: Score | null;
  /** Link to the match on the provider's site, when there is one. */
  sourceUrl: string | null;
}

export const EVENT_TYPES = ['goal', 'own_goal', 'penalty_goal', 'missed_penalty', 'yellow_card', 'red_card', 'second_yellow', 'substitution', 'var', 'other'] as const;
export type MatchEventType = (typeof EVENT_TYPES)[number];

export interface MatchEvent {
  minute: number | null;
  type: MatchEventType;
  /** Provider wording for the event, kept for `other`. */
  label: string;
  side: 'home' | 'away' | null;
  player: string | null;
  /** Score after a goal, when supplied. */
  score: { home: number; away: number } | null;
}

export interface LineupPlayer {
  name: string;
  number: number | null;
  position: string | null;
  captain: boolean;
}

export interface TeamLineup {
  formation: string | null;
  coach: string | null;
  startingXI: LineupPlayer[];
  substitutes: LineupPlayer[];
}

export interface MatchStat {
  label: string;
  home: string | null;
  away: string | null;
}

export interface MatchDetail extends Match {
  events: MatchEvent[] | null;
  lineups: { confirmed: boolean; home: TeamLineup; away: TeamLineup } | null;
  stats: MatchStat[] | null;
}

export interface StandingRow {
  position: number;
  team: TeamRef;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  form: string | null;
}

export interface Standings {
  competition: CompetitionRef;
  season: string | null;
  groups: { name: string | null; rows: StandingRow[] }[];
}

export interface ProviderCapabilities {
  /** Any calendar day can be requested; otherwise only a live/recent window exists. */
  dateRange: boolean;
  competitions: boolean;
  standings: boolean;
  teamMatches: boolean;
  events: boolean;
  lineups: boolean;
  stats: boolean;
  /** Minute-level freshness of live scores (false = delayed scores on this plan). */
  realtimeScores: boolean;
}

export interface Attribution {
  text: string;
  url: string;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  homepage: string;
  /** A visible link the provider's terms require on every page that shows its data. */
  attribution: Attribution | null;
  capabilities: ProviderCapabilities;
  /** Plain-language limits shown to people (coverage, delays). */
  coverageNote: string;
  /** True only for the built-in test fixtures: the UI labels the data as not real. */
  testData: boolean;
}

export type ProviderErrorKind = 'not_configured' | 'rate_limited' | 'timeout' | 'unavailable' | 'bad_response' | 'not_supported';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    /** Seconds the provider asked us to wait (429 Retry-After). */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface FootballProvider {
  readonly info: ProviderInfo;
  /**
   * Matches with kickoff on the given UTC calendar days (inclusive). Providers without
   * `dateRange` return their live/recent window and the caller filters it.
   */
  matches(fromUtcDay: string, toUtcDay: string, signal?: AbortSignal): Promise<Match[]>;
  /** Null when the provider has no such match. */
  match(id: string, signal?: AbortSignal): Promise<MatchDetail | null>;
  /** Recent and upcoming matches of one team; null when unknown or not supported. */
  teamMatches(teamId: string, signal?: AbortSignal): Promise<{ team: TeamRef; matches: Match[] } | null>;
  standings(competitionId: string, signal?: AbortSignal): Promise<Standings | null>;
  competitions(signal?: AbortSignal): Promise<CompetitionRef[]>;
}
