/**
 * Product analytics, feature flags, admin metrics and operational contracts (Phase E1).
 *
 * The event registry is the single allowlist: an event is recorded only when its name is listed
 * here and its properties pass the event's strict schema. Properties carry ids and coarse enums
 * only: never names, emails, free text, raw IPs, URLs with query strings, or search terms.
 */
import { z } from 'zod';
import { CrmStage, Id, Locale } from './schemas.js';

const CountryCode = z.string().regex(/^[A-Z]{2}$/);
const PlanKey = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
/** A route template such as `/u/[handle]` or `/discover`: no query string, no fragment, no raw handle or id. */
const RoutePath = z.string().max(100).regex(/^\/[a-z0-9\-/[\]]*$/, 'a route template without query string');
const Scope = z.enum(['personal', 'organization']);
const ScoutFilterKey = z.enum(['q', 'country', 'position', 'foot', 'skill', 'ageGroup', 'verifiedOnly', 'minFollowers']);

export interface AnalyticsEventSpec {
  props: z.ZodObject;
  /**
   * Strictly necessary: still recorded when the person turned analytics off, because billing
   * reconciliation or safety review depends on it. Everything else is dropped for them.
   */
  necessary: boolean;
  /** May be sent by the web client to POST /v1/events. Server events can never be sent by a client. */
  client: boolean;
  /** Properties removed when the actor is a minor (anything beyond ids that could help identify them). */
  identifying: readonly string[];
}

const spec = (props: z.ZodObject, opts: Partial<Omit<AnalyticsEventSpec, 'props'>> = {}): AnalyticsEventSpec => ({
  props: props.strict(), necessary: false, client: false, identifying: [], ...opts,
});

export const ANALYTICS_EVENTS = {
  // ---------------------------------------------------------------- server events
  signup_completed: spec(z.object({
    roles: z.array(z.enum(['player', 'fan'])).min(1).max(2),
    scoutApplication: z.boolean(),
    locale: Locale,
    country: CountryCode.optional(),
  }), { identifying: ['country'] }),
  upload_started: spec(z.object({ videoId: Id, challenge: z.boolean() })),
  upload_published: spec(z.object({ videoId: Id })),
  profile_viewed: spec(z.object({ profileId: Id, self: z.boolean() })),
  video_viewed: spec(z.object({ videoId: Id })),
  video_liked: spec(z.object({ videoId: Id })),
  video_saved: spec(z.object({ videoId: Id })),
  follow: spec(z.object({ followeeId: Id })),
  /** Which filters were used, never their values. */
  scout_search: spec(z.object({ filters: z.array(ScoutFilterKey).max(8), results: z.number().int().min(0).max(100), firstPage: z.boolean() })),
  shortlist_add: spec(z.object({ shortlistId: Id, playerId: Id })),
  crm_stage_changed: spec(z.object({ entryId: Id, playerId: Id, from: CrmStage.nullable(), to: CrmStage, scope: Scope })),
  contact_requested: spec(z.object({ contactRequestId: Id, playerId: Id, origin: z.enum(['profile', 'pipeline']) }), { necessary: true }),
  contact_accepted: spec(z.object({ contactRequestId: Id }), { necessary: true }),
  checkout_started: spec(z.object({ planKey: PlanKey, interval: z.enum(['month', 'year']), trial: z.boolean() }), { necessary: true }),
  challenge_viewed: spec(z.object({ challengeId: Id })),
  challenge_joined: spec(z.object({ challengeId: Id, invited: z.boolean() })),
  challenge_submitted: spec(z.object({ challengeId: Id, submissionId: Id })),
  challenge_entry_approved: spec(z.object({ challengeId: Id, submissionId: Id })),
  challenge_voted: spec(z.object({ challengeId: Id })),
  subscription_activated: spec(z.object({ planKey: PlanKey, status: z.enum(['trialing', 'active']) }), { necessary: true }),

  // ---------------------------------------------------------------- client events (POST /v1/events)
  page_viewed: spec(z.object({ path: RoutePath }), { client: true }),
  cta_clicked: spec(z.object({ cta: z.string().regex(/^[a-z0-9_]{1,40}$/), path: RoutePath.optional() }), { client: true }),
  locale_changed: spec(z.object({ to: Locale }), { client: true }),
  share_clicked: spec(z.object({ videoId: Id }), { client: true }),
  video_completed: spec(z.object({ videoId: Id, watchedPct: z.number().int().min(0).max(100) }), { client: true }),
  challenge_shared: spec(z.object({ challengeId: Id, kind: z.enum(['invite', 'result']) }), { client: true }),
} as const satisfies Record<string, AnalyticsEventSpec>;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;
export type AnalyticsProps<N extends AnalyticsEventName> = z.input<(typeof ANALYTICS_EVENTS)[N]['props']>;
export const ANALYTICS_EVENT_NAMES = Object.keys(ANALYTICS_EVENTS) as AnalyticsEventName[];
/** The events a browser may send (exactly the registry entries with `client: true`; a unit test keeps them in step). */
export const CLIENT_EVENT_NAMES = ['page_viewed', 'cta_clicked', 'locale_changed', 'share_clicked', 'video_completed', 'challenge_shared'] as const satisfies readonly AnalyticsEventName[];
export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];

export const isAnalyticsEvent = (name: string): name is AnalyticsEventName => Object.hasOwn(ANALYTICS_EVENTS, name);

export type EventDecision =
  | { record: true; properties: Record<string, unknown> }
  | { record: false; reason: 'unknown_event' | 'not_allowed_from_client' | 'opted_out' | 'invalid_properties' };

/**
 * Decides whether one event is recorded and with which properties. Pure: shared by the API's
 * `track()`, the client ingestion endpoint and the worker.
 */
export function prepareEvent(
  name: string,
  properties: unknown,
  ctx: { source: 'server' | 'client'; optedOut: boolean; minor: boolean },
): EventDecision {
  if (!isAnalyticsEvent(name)) return { record: false, reason: 'unknown_event' };
  const s: AnalyticsEventSpec = ANALYTICS_EVENTS[name];
  if (ctx.source === 'client' && !s.client) return { record: false, reason: 'not_allowed_from_client' };
  if (ctx.optedOut && !s.necessary) return { record: false, reason: 'opted_out' };
  const parsed = s.props.safeParse(properties ?? {});
  if (!parsed.success) return { record: false, reason: 'invalid_properties' };
  const out = { ...(parsed.data as Record<string, unknown>) };
  if (ctx.minor) for (const k of s.identifying) delete out[k];
  return { record: true, properties: out };
}

// ---------------------------------------------------------------- client ingestion
export const MAX_CLIENT_EVENTS_PER_BATCH = 20;
export const TrackEventsRequest = z.object({
  events: z.array(z.object({
    name: z.string().max(60),
    properties: z.record(z.string(), z.unknown()).default({}),
  })).min(1).max(MAX_CLIENT_EVENTS_PER_BATCH),
});
export const TrackEventsResponse = z.object({ accepted: z.number().int(), dropped: z.number().int() });

// ---------------------------------------------------------------- North Star and admin metrics
export const NORTH_STAR = {
  key: 'qualified_talent_discoveries',
  name: 'Qualified Talent Discoveries',
  definition:
    'A distinct (discoverer, player) pair, where the discoverer is a verified scout (personal shortlists and pipelines, '
    + 'contact requests) or a verified organization (its pipeline and the contact requests sent for it; an unverified '
    + 'organization\'s actions count for the verified scout who took them), and the player is an active player account '
    + 'other than the discoverer. It qualifies on a UTC day when the discoverer added the player to a shortlist, '
    + 'put or moved the player\'s pipeline card to Shortlisted or a later stage other than Archived (Monitoring, '
    + 'Contact Requested, Contacted, Evaluation), or sent a contact request. Each pair is counted at most once in any '
    + '30-day window: a pair counted on day D is not counted again before D + 30.',
  windowDays: 30,
} as const;

export const MetricPoint = z.object({ day: z.iso.date(), value: z.number().int() });
export const MetricSeries = z.array(MetricPoint);
export const AdminMetricsQuery = z.object({ days: z.coerce.number().int().min(7).max(180).default(30) });
export const FunnelView = z.object({
  key: z.enum(['player_activation', 'scout_discovery', 'checkout']),
  /** Users who did this step and every earlier step inside the window (order within the window is not enforced). */
  steps: z.array(z.object({ event: z.string(), users: z.number().int() })),
});
export const AdminMetrics = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  /** The last day with a completed rollup; later days are not in the series yet. */
  lastRolledDay: z.iso.date().nullable(),
  generatedAt: z.iso.datetime(),
  northStar: z.object({ key: z.string(), name: z.string(), definition: z.string(), total: z.number().int(), series: MetricSeries }),
  dau: MetricSeries,
  wau: MetricSeries,
  uploads: MetricSeries,
  publishes: MetricSeries,
  scoutSearches: MetricSeries,
  contactRequests: MetricSeries,
  funnels: z.array(FunnelView),
});

// ---------------------------------------------------------------- feature flags
export const FlagKey = z.string().regex(/^[a-z][a-z0-9_]{1,59}$/, 'lowercase letters, digits and _ (2 to 60)');
export const FlagAudience = z.object({
  roles: z.array(z.enum(['player', 'fan', 'scout', 'moderator', 'admin'])).min(1).max(5).optional(),
  countries: z.array(CountryCode).min(1).max(100).optional(),
}).strict();
export const FeatureFlagView = z.object({
  key: FlagKey,
  description: z.string(),
  enabled: z.boolean(),
  rolloutPercentage: z.number().int().min(0).max(100),
  audience: FlagAudience,
  clientVisible: z.boolean(),
  updatedBy: Id.nullable(),
  updatedAt: z.iso.datetime(),
});
export const FeatureFlagList = z.object({ items: z.array(FeatureFlagView) });
export const CreateFeatureFlagRequest = z.object({
  key: FlagKey,
  description: z.string().trim().min(1).max(500),
  enabled: z.boolean().default(false),
  rolloutPercentage: z.number().int().min(0).max(100).default(0),
  audience: FlagAudience.default({}),
  clientVisible: z.boolean().default(true),
}).strict();
/** Only the fields sent change (no defaults here, so an omitted field is never reset). */
export const UpdateFeatureFlagRequest = z.object({
  description: z.string().trim().min(1).max(500).optional(),
  enabled: z.boolean().optional(),
  rolloutPercentage: z.number().int().min(0).max(100).optional(),
  audience: FlagAudience.optional(),
  clientVisible: z.boolean().optional(),
}).strict().refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to change');
/** Client-safe flags, already evaluated for the caller. */
export const EvaluatedFlags = z.object({ flags: z.record(z.string(), z.boolean()) });

// ---------------------------------------------------------------- operations
export const HealthView = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  checks: z.object({ database: z.enum(['ok', 'down']) }),
  databaseLatencyMs: z.number().nullable(),
});
export const ReadyView = z.object({
  ready: z.boolean(),
  checks: z.object({ database: z.enum(['ok', 'down']), migrations: z.enum(['ok', 'pending', 'unknown']) }),
});

// ---------------------------------------------------------------- SEO
/** Only what may be indexed: public, discoverable players (minors only with the guardian's public-profile consent) and their public published videos. */
export const SitemapView = z.object({
  profiles: z.array(z.object({ handle: z.string(), updatedAt: z.iso.datetime() })),
  videos: z.array(z.object({ id: Id, updatedAt: z.iso.datetime() })),
  /** Open, judging or completed public challenges with enough content to be useful (see challengeIndexable). */
  challenges: z.array(z.object({ slug: z.string(), updatedAt: z.iso.datetime() })).default([]),
});
export const SeoProfileView = z.object({
  handle: z.string(),
  displayName: z.string(),
  bio: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  position: z.string().nullable(),
  verified: z.boolean(),
  updatedAt: z.iso.datetime(),
});
