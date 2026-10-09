/**
 * KICKSCOUT Challenges contracts: catalog, entries, judging, leaderboards, results, admin.
 * See docs/challenges.md.
 */
import { z } from 'zod';
import {
  AgeBand, Bilingual, ChallengeCategory, ChallengeDifficulty, ChallengeFormat, ChallengeStatus, ChallengeView, CursorQuery, Handle, Hashtag,
  Id, SkillKey, VideoContentType, VideoDetails, VideoView, MAX_UPLOAD_BYTES,
} from './schemas.js';

// ---------------------------------------------------------------- rubric
export const RubricComponent = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  kind: z.enum(['measure', 'penalty', 'criterion']),
  label: Bilingual,
  max: z.number().positive().max(1_000_000),
  weight: z.number().min(0).max(1).optional(),
  perUnit: z.number().positive().max(1_000_000).optional(),
});
export const TieBreaker = z.string().regex(/^(fewer_penalties|earliest_submission|(higher|lower)_component:[a-z][a-z0-9_]{0,40})$/);
export const Rubric = z.object({
  method: z.enum(['measured', 'judged']),
  unit: z.enum(['count', 'ms', 'hits', 'points']),
  direction: z.enum(['higher', 'lower']),
  components: z.array(RubricComponent).min(1).max(12),
  attempts: z.number().int().min(1).max(100).nullable().optional(),
  tieBreakers: z.array(TieBreaker).max(4),
  minJudges: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  tolerance: z.number().min(0).max(1_000_000),
  summary: Bilingual,
  aiCapability: z.string().max(40).nullable().optional(),
});
/** What everyone may see about how a challenge is scored. */
export const PublicRubric = Rubric.omit({ aiCapability: true }).extend({ version: z.number().int(), frozen: z.boolean() });

export const ChallengeRuleKind = z.enum(['eligibility', 'disqualification', 'safety', 'recording', 'general']);
export const ChallengeRule = z.object({ kind: ChallengeRuleKind, body: Bilingual });
export const ChallengeRecording = z.object({
  camera: z.enum(['side', 'front', 'behind', 'any']),
  orientation: z.enum(['vertical', 'horizontal', 'any']),
  continuousTake: z.boolean(),
  notes: Bilingual.optional(),
});

// ---------------------------------------------------------------- shared views
export const ChallengeRef = z.object({ id: Id, slug: z.string(), title: Bilingual });
export const SubmissionState = z.enum([
  'pending_upload', 'processing', 'pending_moderation', 'pending_judging', 'approved', 'rejected', 'disqualified', 'failed_processing', 'withdrawn',
]);
export const ScoreView = z.object({
  value: z.number(),
  unit: z.enum(['count', 'ms', 'hits', 'points']),
  direction: z.enum(['higher', 'lower']),
  penalties: z.number(),
  components: z.array(z.object({ key: z.string(), label: Bilingual, value: z.number() })),
  method: z.enum(['measured', 'judged']),
  reviewStatus: z.enum(['confirmed', 'disputed', 'overturned']),
  rubricVersion: z.number().int(),
});
export const AppealView = z.object({
  id: Id,
  submissionId: Id,
  challenge: ChallengeRef,
  reason: z.string(),
  status: z.enum(['open', 'upheld', 'rejected']),
  resolution: z.string().nullable(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
export const MySubmissionView = z.object({
  id: Id,
  challenge: ChallengeRef,
  videoId: Id,
  thumbnailUrl: z.string().nullable(),
  attemptNo: z.number().int(),
  state: SubmissionState,
  stateReason: z.string().nullable(),
  claimedValue: z.number().nullable(),
  score: ScoreView.nullable(),
  /** Place on the live (or final) leaderboard, when the entry is approved and public. */
  rank: z.number().int().nullable(),
  appeal: AppealView.nullable(),
  canAppeal: z.boolean(),
  canWithdraw: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const Eligibility = z.object({ allowed: z.boolean(), code: z.string().nullable(), reason: z.string().nullable() });

export const ChallengeDetailView = ChallengeView.extend({
  instructions: Bilingual,
  equipment: z.array(Bilingual),
  safetyNotes: Bilingual.nullable(),
  recording: ChallengeRecording,
  minDurationS: z.number().int(),
  maxDurationS: z.number().int(),
  attemptLimit: z.number().int(),
  retryFailed: z.boolean(),
  requiresPartner: z.boolean(),
  needsSafetyAck: z.boolean(),
  rules: z.array(ChallengeRule),
  rubric: PublicRubric.nullable(),
  demoVideo: VideoView.nullable(),
  resultsPublishedAt: z.iso.datetime().nullable(),
  /** Whether search engines may index this page (see the SEO agent). */
  indexable: z.boolean(),
  me: z.object({
    joined: z.boolean(),
    participationStatus: z.enum(['active', 'withdrawn', 'disqualified']).nullable(),
    attemptsUsed: z.number().int(),
    attemptsLeft: z.number().int(),
    eligibility: Eligibility,
    submissions: z.array(MySubmissionView),
    votesLeft: z.number().int(),
    votedFor: z.array(Id),
  }).nullable(),
});

export const ChallengeHubView = z.object({
  featured: ChallengeView.nullable(),
  trending: z.array(ChallengeView),
  newest: z.array(ChallengeView),
  endingSoon: z.array(ChallengeView),
  beginner: z.array(ChallengeView),
  advancedFreestyle: z.array(ChallengeView),
  upcoming: z.array(ChallengeView),
  completed: z.array(ChallengeView),
});

// ---------------------------------------------------------------- entering
const EntryFlags = {
  /** Client-generated; resending the same key returns the same entry instead of creating another. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  claimedValue: z.number().min(0).max(1_000_000).optional(),
  othersInClip: z.boolean().default(false),
  consentOthers: z.boolean().default(false),
  safetyAck: z.boolean().default(false),
  targetSubmissionId: Id.optional(),
  /** Handle of the player whose invite link brought this entrant. */
  ref: Handle.optional(),
};
export const ChallengeSubmissionRequest = VideoDetails.extend({
  rightsConfirmed: z.literal(true, { error: 'confirm that you own this video or have the rights to post it' }),
  contentType: VideoContentType,
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  trimStartMs: z.number().int().min(0).optional(),
  trimEndMs: z.number().int().positive().optional(),
  ...EntryFlags,
}).refine((v) => v.trimStartMs === undefined || v.trimEndMs === undefined || v.trimEndMs > v.trimStartMs, { message: 'trim end must be after trim start', path: ['trimEndMs'] });
export const ChallengeSubmissionResponse = z.object({
  submissionId: Id,
  videoId: Id,
  state: SubmissionState,
  /** Null when the clip already arrived (a resent request for an entry past upload). */
  upload: z.object({ url: z.url(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()), expiresAt: z.iso.datetime() }).nullable(),
});
/** Enter a clip you already uploaded during the challenge window. */
export const EnterChallengeRequest = z.object({
  videoId: Id,
  idempotencyKey: EntryFlags.idempotencyKey.optional(),
  claimedValue: EntryFlags.claimedValue,
  othersInClip: EntryFlags.othersInClip,
  consentOthers: EntryFlags.consentOthers,
  safetyAck: EntryFlags.safetyAck,
  targetSubmissionId: EntryFlags.targetSubmissionId,
});
export const JoinChallengeRequest = z.object({ ref: Handle.optional(), safetyAck: z.boolean().default(false) });
export const AppealRequest = z.object({ reason: z.string().trim().min(10).max(1000) });
export const VoteResponse = z.object({ counted: z.boolean(), votesLeft: z.number().int() });

// ---------------------------------------------------------------- leaderboards and results
export const LeaderboardPlayer = z.object({
  userId: Id, handle: z.string(), displayName: z.string(), avatarUrl: z.string().nullable(), verified: z.boolean(), isDemo: z.boolean(),
});
export const LeaderboardEntry = z.object({
  rank: z.number().int(),
  submissionId: Id,
  videoId: Id,
  player: LeaderboardPlayer,
  value: z.number(),
  penalties: z.number(),
  country: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
});
export const LeaderboardQuery = z.object({
  /** `overall`, or a two-letter country code (only players who show their country are listed). */
  scope: z.string().regex(/^(overall|[A-Z]{2})$/).default('overall'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const LeaderboardView = z.object({
  scope: z.string(),
  kind: z.enum(['live', 'final']),
  unit: z.enum(['count', 'ms', 'hits', 'points']),
  direction: z.enum(['higher', 'lower']),
  computedAt: z.iso.datetime(),
  entries: z.array(LeaderboardEntry),
  me: LeaderboardEntry.nullable(),
});
export const ChallengeResultsView = z.object({
  published: z.boolean(),
  publishedAt: z.iso.datetime().nullable(),
  podium: z.array(LeaderboardEntry),
  communityFavorite: LeaderboardEntry.extend({ votes: z.number().int() }).nullable(),
  scoutPicks: z.array(LeaderboardEntry.extend({ picks: z.number().int() })),
  participants: z.number().int(),
  approvedEntries: z.number().int(),
});

// ---------------------------------------------------------------- my challenges
export const BadgeView = z.object({
  key: z.string(), name: Bilingual, description: Bilingual, icon: z.string(), awardedAt: z.iso.datetime(), challenge: ChallengeRef.nullable(),
});
export const PersonalBestView = z.object({
  templateKey: z.string(), title: Bilingual, unit: z.enum(['count', 'ms', 'hits', 'points']), direction: z.enum(['higher', 'lower']),
  value: z.number(), challenge: ChallengeRef, at: z.iso.datetime(),
});
export const HeadToHeadView = z.object({
  id: Id,
  challenge: ChallengeRef,
  role: z.enum(['challenger', 'opponent']),
  other: z.object({ userId: Id, handle: z.string(), displayName: z.string() }),
  status: z.enum(['pending', 'accepted', 'declined', 'completed', 'expired', 'cancelled']),
  result: z.enum(['won', 'lost', 'draw']).nullable(),
  createdAt: z.iso.datetime(),
});
export const RecommendedChallenge = z.object({ challenge: ChallengeView, reasons: z.array(z.string()) });
export const MyChallengesView = z.object({
  active: z.array(z.object({ challenge: ChallengeView, attemptsUsed: z.number().int(), attemptsLeft: z.number().int(), best: ScoreView.nullable() })),
  submissions: z.array(MySubmissionView),
  badges: z.array(BadgeView),
  personalBests: z.array(PersonalBestView),
  streakWeeks: z.number().int(),
  challengeXp: z.number().int(),
  headToHeads: z.array(HeadToHeadView),
  appeals: z.array(AppealView),
});
export const RecommendedChallengesView = z.object({ items: z.array(RecommendedChallenge) });
export const CreateHeadToHeadRequest = z.object({ opponentId: Id });
export const ScoutPickRequest = z.object({ submissionId: Id });

// ---------------------------------------------------------------- judging
export const VerificationCheckView = z.object({ key: z.string(), pass: z.boolean().nullable(), detail: z.string().nullable() });
export const JudgeQueueQuery = CursorQuery.extend({ challengeId: Id.optional() });
/** Judges see the clip and the rules, never who the player is: judging is blind. */
export const JudgeItemView = z.object({
  submissionId: Id,
  challenge: ChallengeRef,
  rubric: PublicRubric,
  video: z.object({ id: Id, playbackUrl: z.string().nullable(), thumbnailUrl: z.string().nullable(), durationMs: z.number().int().nullable() }),
  attemptNo: z.number().int(),
  claimedValue: z.number().nullable(),
  round: z.number().int(),
  reviewsThisRound: z.number().int(),
  judgesNeeded: z.number().int(),
  reviewedByMe: z.boolean(),
  checks: z.array(VerificationCheckView),
  flags: z.array(z.enum(['disagreement', 'claim_mismatch', 'duplicate_suspected', 'football_not_detected', 'appeal'])),
  createdAt: z.iso.datetime(),
});
export const JudgeQueueView = z.object({ items: z.array(JudgeItemView), nextCursor: z.string().nullable() });
export const JudgeReviewRequest = z.object({
  decision: z.enum(['score', 'disqualify', 'escalate']),
  components: z.record(z.string(), z.number()).optional(),
  evidence: z.array(z.object({ atMs: z.number().int().min(0).max(600_000), note: z.string().trim().max(200) })).max(20).default([]),
  notes: z.string().trim().max(1000).optional(),
}).refine((v) => v.decision !== 'score' || v.components, { message: 'scores need component values', path: ['components'] })
  .refine((v) => v.decision === 'score' || (v.notes && v.notes.length >= 5), { message: 'say why', path: ['notes'] });
export const JudgeReviewResult = z.object({
  state: SubmissionState,
  outcome: z.enum(['need_more', 'approved', 'disagreement', 'disqualified', 'escalated']),
});

// ---------------------------------------------------------------- admin
const AdminChallengeFields = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,60}$/),
  /** Required unless `fromTemplate` gives them. */
  title: Bilingual.optional(),
  description: Bilingual.optional(),
  instructions: Bilingual.default({ en: '', ar: '' }),
  skillKey: SkillKey.optional(),
  hashtag: Hashtag.optional(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  timezone: z.string().min(1).max(64).default('UTC'),
  format: ChallengeFormat.default('standard'),
  category: ChallengeCategory.default('freestyle'),
  difficulty: ChallengeDifficulty.default('beginner'),
  ageGroups: z.array(AgeBand).min(1).max(4).default(['u13', 'u16', 'u18', 'adult']),
  equipment: z.array(Bilingual).max(10).default([]),
  safetyNotes: Bilingual.nullable().default(null),
  recording: ChallengeRecording.default({ camera: 'any', orientation: 'any', continuousTake: true }),
  minDurationS: z.number().int().min(1).max(180).default(3),
  maxDurationS: z.number().int().min(1).max(180).default(60),
  attemptLimit: z.number().int().min(1).max(10).default(3),
  retryFailed: z.boolean().default(true),
  requiresPartner: z.boolean().default(false),
  visibility: z.enum(['public', 'unlisted']).default('public'),
  featured: z.boolean().default(false),
  votingEnabled: z.boolean().default(true),
  reward: Bilingual.nullable().default(null),
  demoVideoId: Id.nullable().default(null),
  rules: z.array(ChallengeRule).max(30).default([]),
  rubric: Rubric.optional(),
  /** Copy everything not given here from an installed template. */
  fromTemplate: z.string().regex(/^tpl-[a-z0-9-]{2,56}$/).optional(),
});
export const AdminChallengeInput = AdminChallengeFields.refine((v) => v.fromTemplate || (v.title && v.description), { message: 'a title and description are required', path: ['title'] });
export const AdminChallengePatch = AdminChallengeFields.omit({ slug: true, rubric: true, fromTemplate: true }).partial();
export const ChallengeTransitionRequest = z.object({
  action: z.enum(['publish', 'pause', 'resume', 'cancel', 'close', 'complete', 'archive']),
  /** complete only: publish results although entries are still in moderation or judging (they stay unranked). */
  force: z.boolean().default(false),
});
export const RubricVersionRequest = z.object({ rubric: Rubric });
export const ChallengeJudgesRequest = z.object({ userIds: z.array(Id).max(20) });
export const AppealResolveRequest = z.object({
  decision: z.enum(['uphold', 'reject']),
  resolution: z.string().trim().min(5).max(1000),
  /** When upholding: new component values (re-score), or reinstate a disqualified entry for judging. */
  rescore: z.record(z.string(), z.number()).optional(),
  reinstate: z.boolean().optional(),
});
export const AdminChallengeQuery = z.object({ status: ChallengeStatus.optional(), templates: z.coerce.boolean().default(false) });
export const AdminChallengeView = ChallengeDetailView.omit({ me: true }).extend({
  status: ChallengeStatus,
  isTemplate: z.boolean(),
  templateKey: z.string().nullable(),
  visibility: z.enum(['public', 'unlisted']),
  rubricVersions: z.array(z.object({ id: Id, version: z.number().int(), method: z.enum(['measured', 'judged']), frozen: z.boolean(), current: z.boolean(), createdAt: z.iso.datetime() })),
  judges: z.array(z.object({ userId: Id, handle: z.string(), displayName: z.string() })),
  counts: z.record(SubmissionState, z.number().int()),
  openAppeals: z.number().int(),
  setAsideVotes: z.number().int(),
});
export const AdminChallengeList = z.object({ items: z.array(AdminChallengeView) });
export const AdminAppealList = z.object({ items: z.array(AppealView.extend({ score: ScoreView.nullable(), state: SubmissionState, videoId: Id })) });
export const ChallengeFraudView = z.object({
  duplicates: z.array(z.object({ submissionId: Id, videoId: Id, matchesVideoId: Id })),
  voteBursts: z.array(z.object({ submissionId: Id, votes: z.number().int(), youngAccounts: z.number().int(), windowStart: z.iso.datetime() })),
  setAsideVotes: z.array(z.object({ submissionId: Id, count: z.number().int(), reason: z.string() })),
});
export const ChallengeMetricsView = z.object({
  challenges: z.array(z.object({
    challenge: ChallengeRef,
    status: ChallengeStatus,
    participants: z.number().int(),
    submissions: z.number().int(),
    approved: z.number().int(),
    /** Share of entrants with at least one approved entry. */
    completionRate: z.number().nullable(),
    /** Share of finished entries the safety pipeline rejected. */
    moderationRejectionRate: z.number().nullable(),
    disqualified: z.number().int(),
    medianHoursToResult: z.number().nullable(),
    appeals: z.number().int(),
    appealRate: z.number().nullable(),
    disagreements: z.number().int(),
    eligibleVotes: z.number().int(),
    setAsideVotes: z.number().int(),
    scoutPicks: z.number().int(),
    /** Entrants a verified scout shortlisted after the challenge started. */
    scoutShortlists: z.number().int(),
    invitedEntrants: z.number().int(),
  })),
  agents: z.array(z.object({
    agent: z.string(), runs: z.number().int(), errors: z.number().int(), routedToHuman: z.number().int(), flagged: z.number().int(),
    avgLatencyMs: z.number().nullable(), costUsd: z.number(),
  })),
  stuckSubmissions: z.number().int(),
  judgingBacklog: z.number().int(),
});
export const TemplateInstallResult = z.object({ installed: z.array(z.string()), skipped: z.array(z.string()) });
export const SeoChallengeView = z.object({
  slug: z.string(), title: Bilingual, description: Bilingual, phase: z.string(), startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
  hashtag: z.string().nullable(), thumbnailUrl: z.string().nullable(), updatedAt: z.iso.datetime(),
});
