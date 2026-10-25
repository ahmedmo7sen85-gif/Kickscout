/**
 * Football utility contracts: scores, match pages, standings, favourites and match alerts.
 * Mirrors the model in @fp/football; every response carries `source` so the UI can always say
 * where the data came from, when it was fetched and whether it is stale.
 */
import { z } from 'zod';
import { Locale } from './schemas.js';

const Iso = z.string();
const Id = z.string().min(1).max(130);

export const MatchStatus = z.enum(['scheduled', 'live', 'halftime', 'finished', 'postponed', 'suspended', 'cancelled', 'abandoned', 'unknown']);
export const FootballProviderId = z.enum(['sportscore', 'football-data', 'fixture']);

export const TeamRefView = z.object({ id: Id, name: z.string(), logoUrl: z.string().nullable() });
export const CompetitionRefView = z.object({ id: Id.nullable(), name: z.string(), logoUrl: z.string().nullable(), area: z.string().nullable() });
export const ScoreView = z.object({ home: z.number().int().nullable(), away: z.number().int().nullable() });

export const MatchView = z.object({
  id: Id,
  provider: FootballProviderId,
  kickoff: Iso,
  status: MatchStatus,
  statusText: z.string().nullable(),
  minute: z.number().int().nullable(),
  competition: CompetitionRefView,
  home: TeamRefView,
  away: TeamRefView,
  score: ScoreView,
  halftime: ScoreView.nullable(),
  sourceUrl: z.string().nullable(),
});

const LineupPlayerView = z.object({ name: z.string(), number: z.number().int().nullable(), position: z.string().nullable(), captain: z.boolean() });
const TeamLineupView = z.object({ formation: z.string().nullable(), coach: z.string().nullable(), startingXI: z.array(LineupPlayerView), substitutes: z.array(LineupPlayerView) });

export const MatchDetailView = MatchView.extend({
  events: z.array(z.object({
    minute: z.number().int().nullable(),
    type: z.enum(['goal', 'own_goal', 'penalty_goal', 'missed_penalty', 'yellow_card', 'red_card', 'second_yellow', 'substitution', 'var', 'other']),
    label: z.string(),
    side: z.enum(['home', 'away']).nullable(),
    player: z.string().nullable(),
    score: z.object({ home: z.number().int(), away: z.number().int() }).nullable(),
  })).nullable(),
  lineups: z.object({ confirmed: z.boolean(), home: TeamLineupView, away: TeamLineupView }).nullable(),
  stats: z.array(z.object({ label: z.string(), home: z.string().nullable(), away: z.string().nullable() })).nullable(),
});

export const ProviderCapabilitiesView = z.object({
  dateRange: z.boolean(), competitions: z.boolean(), standings: z.boolean(), teamMatches: z.boolean(),
  events: z.boolean(), lineups: z.boolean(), stats: z.boolean(), realtimeScores: z.boolean(),
});

/** Provenance on every football response. */
export const SourceView = z.object({
  provider: FootballProviderId,
  name: z.string(),
  homepage: z.string(),
  /** A link the provider's terms require next to its data; render it as a normal (followed) link. */
  attribution: z.object({ text: z.string(), url: z.string() }).nullable(),
  testData: z.boolean(),
  coverageNote: z.string(),
  capabilities: ProviderCapabilitiesView,
  /** Last successful fetch from the provider (null when nothing has been fetched yet). */
  fetchedAt: Iso.nullable(),
  /** True when the provider failed and this is the last good copy. Never shown as current. */
  stale: z.boolean(),
});

export const MatchListQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tz: z.string().max(64).optional(),
  competition: z.string().max(80).optional(),
  status: z.enum(['all', 'live', 'upcoming', 'finished']).default('all'),
});

export const MatchListView = z.object({
  source: SourceView,
  day: z.string(),
  timeZone: z.string(),
  range: z.object({ start: Iso, end: Iso }),
  /** `day`: the provider answered for this day. `recent-window`: it only has live/recent matches, filtered to this day. */
  coverage: z.enum(['day', 'recent-window']),
  competitions: z.array(CompetitionRefView),
  matches: z.array(MatchView),
});

export const MatchDetailResponse = z.object({ source: SourceView, match: MatchDetailView });
export const TeamMatchesView = z.object({ source: SourceView, team: TeamRefView, matches: z.array(MatchView) });
export const StandingsView = z.object({
  source: SourceView,
  competition: CompetitionRefView,
  season: z.string().nullable(),
  groups: z.array(z.object({
    name: z.string().nullable(),
    rows: z.array(z.object({
      position: z.number().int(), team: TeamRefView, played: z.number().int(), won: z.number().int(), drawn: z.number().int(), lost: z.number().int(),
      goalsFor: z.number().int(), goalsAgainst: z.number().int(), goalDifference: z.number().int(), points: z.number().int(), form: z.string().nullable(),
    })),
  })),
});
export const CompetitionsView = z.object({ source: SourceView, competitions: z.array(CompetitionRefView) });

export const FootballSearchQuery = z.object({ q: z.string().trim().min(2).max(60) });
export const FootballSearchView = z.object({ teams: z.array(TeamRefView), competitions: z.array(CompetitionRefView) });

export const FootballStatusView = z.object({
  enabled: z.boolean(),
  source: SourceView.nullable(),
  health: z.object({
    lastSuccessAt: Iso.nullable(),
    lastErrorAt: Iso.nullable(),
    lastErrorKind: z.string().nullable(),
    consecutiveFailures: z.number().int(),
  }).nullable(),
  push: z.object({ available: z.boolean() }),
});

// ---------------------------------------------------------------- favourites
export const FavoritesView = z.object({
  provider: FootballProviderId.nullable(),
  teams: z.array(TeamRefView),
  competitions: z.array(CompetitionRefView),
});
export const FavoriteImportRequest = z.object({
  teams: z.array(Id).max(50).default([]),
  competitions: z.array(Id).max(50).default([]),
});

// ---------------------------------------------------------------- match alerts (Web Push)
export const AlertCategory = z.enum(['starting_soon', 'kickoff', 'goal', 'halftime', 'final_result', 'lineups']);
export const AlertPreferencesView = z.object({
  enabled: z.boolean(),
  categories: z.record(AlertCategory, z.boolean()),
  /** Categories this data source cannot produce (they stay off whatever the setting). */
  unsupported: z.array(AlertCategory),
});
export const UpdateAlertPreferencesRequest = z.object({
  enabled: z.boolean().optional(),
  categories: z.partialRecord(AlertCategory, z.boolean()).optional(),
});

export const PushConfigView = z.object({ available: z.boolean(), publicKey: z.string().nullable() });
const Endpoint = z.url().max(1000).refine((u) => u.startsWith('https://'), 'push endpoints are https');
export const PushSubscribeRequest = z.object({
  endpoint: Endpoint,
  keys: z.object({ p256dh: z.string().min(40).max(200).regex(/^[A-Za-z0-9_-]+=*$/), auth: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+=*$/) }),
  locale: Locale.default('en'),
});
export const PushEndpointRequest = z.object({ endpoint: Endpoint });
export const PushStatusView = z.object({ registered: z.boolean(), devices: z.number().int() });
export const PushTestResult = z.object({ sent: z.number().int(), failed: z.number().int(), removed: z.number().int() });

export const FootballCronReport = z.object({
  ran: z.boolean(),
  matchesChecked: z.number().int(),
  alerts: z.number().int(),
  sent: z.number().int(),
  failed: z.number().int(),
  removed: z.number().int(),
  skippedReason: z.string().nullable(),
});
