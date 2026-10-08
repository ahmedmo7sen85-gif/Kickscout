/**
 * API contracts. These Zod schemas validate requests and responses in the API, generate the
 * OpenAPI document, and type the clients. Nothing is declared twice.
 */
import { z } from 'zod';

export const Id = z.uuid();
export const Locale = z.enum(['en', 'ar']);
export const Position = z.enum(['GK', 'CB', 'LB', 'RB', 'DM', 'CM', 'AM', 'LW', 'RW', 'ST']);
export const Foot = z.enum(['left', 'right', 'both']);
export const AgeBand = z.enum(['u13', 'u16', 'u18', 'adult']);
export const CapabilityStatus = z.enum(['live', 'prototype', 'coming_soon', 'requires_model_integration']);
export const Capability = z.object({
  key: z.string(),
  status: CapabilityStatus,
  label: z.object({ en: z.string(), ar: z.string() }).nullable(),
});

// RFC 9457 problem details with a stable machine code.
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  traceId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export const CursorQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ---------------------------------------------------------------- onboarding and consent
export const Handle = z.string().regex(/^[a-zA-Z0-9_.]{3,30}$/, 'letters, digits, _ and . (3 to 30)');

export const RegisterRequest = z.object({
  handle: Handle,
  displayName: z.string().trim().min(1).max(60),
  dob: z.iso.date(),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  roles: z.array(z.enum(['player', 'fan', 'creator'])).min(1).max(3),
  locale: Locale.default('en'),
});
export const RegisterResponse = z.object({
  userId: Id,
  status: z.enum(['pending_consent', 'active']),
  guardianRequired: z.boolean(),
});

export const GuardianInviteRequest = z.object({ guardianEmail: z.email() });
export const GuardianInviteResponse = z.object({ invitationId: Id, expiresAt: z.iso.datetime() });
export const GuardianAcceptRequest = z.object({ token: z.string().min(32).max(200) });

export const ConsentPurpose = z.enum(['account', 'public_profile', 'ai_analysis', 'model_training', 'leaderboards', 'scout_contact']);
export const ConsentRequest = z.object({
  subjectId: Id,
  purpose: ConsentPurpose,
  granted: z.boolean(),
  policyVersion: z.string().min(1).max(40),
});
export const ConsentState = z.object({
  subjectId: Id,
  consents: z.array(z.object({ purpose: ConsentPurpose, granted: z.boolean(), policyVersion: z.string(), at: z.iso.datetime() })),
});

// ---------------------------------------------------------------- profiles
export const RegionView = z.object({ macro: z.string().nullable(), country: z.string().nullable(), city: z.string().nullable() });
export const PlayerFacts = z.object({
  primaryPosition: Position.nullable(),
  secondaryPositions: z.array(Position),
  preferredFoot: Foot.nullable(),
});
export const ProfileView = z.object({
  userId: Id,
  handle: z.string(),
  displayName: z.string(),
  bio: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  ageGroup: AgeBand.nullable(),
  isMinor: z.boolean().nullable(),
  email: z.string().nullable(),
  region: RegionView,
  player: PlayerFacts.nullable(),
  canDirectMessage: z.boolean(),
  canRequestContact: z.boolean(),
  followers: z.number().int(),
  following: z.number().int(),
});
export const UpdateProfileRequest = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  bio: z.string().max(300).nullable().optional(),
  regionCode: z.string().max(40).nullable().optional(),
  player: PlayerFacts.partial().optional(),
});
export const MeView = z.object({
  userId: Id,
  status: z.enum(['pending_consent', 'active', 'suspended', 'deleted']),
  roles: z.array(z.string()),
  ageGroup: AgeBand,
  guardianRequired: z.boolean(),
  profile: ProfileView,
});

// ---------------------------------------------------------------- media
export const VideoContentType = z.enum(['video/mp4', 'video/quicktime', 'video/webm']);
export const VideoType = z.enum(['match', 'training', 'skill_challenge', 'freestyle', 'goalkeeper', 'skills_compilation',
  'tactical_sequence', 'shooting', 'passing', 'dribbling', 'defending']);
export const VideoSubject = z.enum(['me', 'another_player', 'multiple_players', 'unknown']);
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export const CreateUploadRequest = z.object({
  contentType: VideoContentType,
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  videoType: VideoType,
  subject: VideoSubject,
  caption: z.string().max(500).optional(),
  visibility: z.enum(['public', 'followers', 'private']).default('public'),
});
export const CreateUploadResponse = z.object({
  videoId: Id,
  upload: z.object({ url: z.url(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()), expiresAt: z.iso.datetime() }),
});

export const VideoView = z.object({
  id: Id,
  owner: z.object({ userId: Id, handle: z.string(), displayName: z.string() }),
  status: z.enum(['awaiting_upload', 'uploaded', 'processing', 'ready', 'rejected', 'deleted']),
  videoType: VideoType,
  caption: z.string().nullable(),
  playbackUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  likes: z.number().int(),
  comments: z.number().int(),
  likedByMe: z.boolean(),
  createdAt: z.iso.datetime(),
});

// ---------------------------------------------------------------- feed and social
export const FeedTab = z.enum(['for_you', 'new_talent', 'following', 'trending', 'skills', 'match_clips', 'challenges', 'nearby_talent']);
export const FeedQuery = CursorQuery.extend({ tab: FeedTab.default('for_you') });
export const FeedPage = z.object({
  tab: FeedTab,
  capability: Capability,
  items: z.array(VideoView),
  nextCursor: z.string().nullable(),
});

export const CreateCommentRequest = z.object({ body: z.string().trim().min(1).max(2000), parentId: Id.optional() });
export const CommentView = z.object({
  id: Id,
  author: z.object({ userId: Id, handle: z.string() }),
  body: z.string(),
  status: z.enum(['pending', 'visible', 'held', 'removed']),
  createdAt: z.iso.datetime(),
});
export const CommentPage = z.object({ items: z.array(CommentView), nextCursor: z.string().nullable() });

export const ReportRequest = z.object({
  targetKind: z.enum(['video', 'comment', 'user']),
  targetId: Id,
  reason: z.enum(['spam', 'harassment', 'hate', 'sexual', 'violence', 'child_safety', 'impersonation', 'copyright', 'stolen_video', 'other']),
  details: z.string().max(1000).optional(),
});

// ---------------------------------------------------------------- analysis and intelligence
export const NormalizedBox = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) })
  .refine((b) => b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001, 'box must lie inside the frame');

export const CreateAnalysisRequest = z.object({
  frameMs: z.number().int().min(0),
  box: NormalizedBox,
  claimedPlayerId: Id.optional(),
  tier: z.enum(['basic', 'advanced']).default('basic'),
});
export const AnalysisView = z.object({
  id: Id,
  videoId: Id,
  status: z.enum(['queued', 'running', 'done', 'failed', 'rejected_quality']),
  pipelineVersion: z.string(),
  tier: z.enum(['basic', 'advanced', 'batch']),
  selection: z.object({ frameMs: z.number().int(), box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }), confirmed: z.boolean() }),
  quality: z.object({ score: z.number().nullable(), readiness: z.number().nullable(), limitations: z.array(z.string()) }),
  capabilities: z.array(Capability),
  createdAt: z.iso.datetime(),
});

export const SkillScoreView = z.object({
  skill: z.string(),
  status: z.enum(['assessed', 'insufficient_evidence']),
  score: z.number().nullable(),
  confidence: z.number(),
  calibrated: z.boolean(),
  evidenceCount: z.number().int(),
  evidenceQuality: z.enum(['low', 'medium', 'high']),
  methodVersion: z.string(),
  capability: Capability,
});
export const SkillExplanationView = SkillScoreView.extend({
  explanation: z.object({
    observedActions: z.number().int(),
    successful: z.number().int(),
    unsuccessful: z.number().int(),
    underPressure: z.number().int(),
    distinctVideos: z.number().int(),
    positiveIndicators: z.array(z.string()),
    negativeIndicators: z.array(z.string()),
    limitations: z.array(z.string()),
  }),
  clips: z.array(z.object({ observationId: Id, videoId: Id, tStartMs: z.number().int(), tEndMs: z.number().int(), outcome: z.string(), confidence: z.number() })),
});
export const DnaView = z.object({
  playerId: Id,
  version: z.number().int().nullable(),
  capability: Capability,
  dna: z.unknown().nullable(),
  message: z.object({ en: z.string(), ar: z.string() }).nullable(),
});
