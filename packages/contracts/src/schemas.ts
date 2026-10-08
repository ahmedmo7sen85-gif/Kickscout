/**
 * API contracts. These Zod schemas validate requests and responses in the API, generate the
 * OpenAPI document, and type the clients. Nothing is declared twice.
 */
import { z } from 'zod';

export const Id = z.uuid();
export const Locale = z.enum(['en', 'ar']);
export const Position = z.enum(['GK', 'CB', 'LB', 'RB', 'DM', 'CM', 'AM', 'LW', 'RW', 'ST']);
export const Foot = z.enum(['left', 'right', 'both']);
export const SkillKey = z.enum(['dribbling', 'elastico', 'step_over', 'rainbow_flick', 'cruyff_turn', 'roulette', 'nutmeg',
  'ball_control', 'first_touch', 'juggling', 'passing', 'crossing', 'shooting', 'free_kick', 'volley', 'speed', 'one_v_one',
  'freestyle', 'defending', 'goalkeeping']);
export const Bilingual = z.object({ en: z.string(), ar: z.string() });
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
  roles: z.array(z.enum(['player', 'fan'])).min(1).max(2),
  /** Scouts sign up as fans and apply; staff grant the scout role after checking. */
  scoutApplication: z.object({ organization: z.string().trim().min(2).max(120), evidence: z.string().trim().min(10).max(1000) }).optional(),
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

export const ConsentPurpose = z.enum(['account', 'public_profile', 'scout_contact', 'model_training']);
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
  verified: z.boolean(),
  isDemo: z.boolean(),
  stats: z.object({ followers: z.number().int(), following: z.number().int(), videos: z.number().int(), likes: z.number().int() }),
  followedByMe: z.boolean(),
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
  scoutApplication: z.enum(['none', 'pending', 'approved', 'rejected']),
  unreadNotifications: z.number().int(),
  profile: ProfileView,
});

// ---------------------------------------------------------------- taxonomy
export const SkillView = z.object({ key: SkillKey, category: z.string(), name: Bilingual });
export const SkillList = z.object({ items: z.array(SkillView) });

// ---------------------------------------------------------------- videos
/** Declared by the client for the signed upload. The worker checks the real file and decides. */
export const VideoContentType = z.enum(['video/mp4', 'video/quicktime', 'video/webm']);
export const VideoStatus = z.enum(['uploading', 'processing', 'analyzing', 'review_required', 'published', 'rejected', 'failed', 'deleted']);
export const ModerationVerdict = z.enum(['safe', 'flagged', 'review_required', 'rejected']);
export const VideoContext = z.enum(['match', 'training', 'freestyle', 'challenge', 'other']);
export const Visibility = z.enum(['public', 'followers', 'private']);
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_DURATION_MS = 180_000;
export const Hashtag = z.string().trim().max(41).transform((t) => t.replace(/^#+/, '').toLowerCase())
  .pipe(z.string().regex(/^[\p{L}\p{N}_]{1,40}$/u, 'letters, digits and _ only'));

export const VideoDetails = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  skillKey: SkillKey.optional(),
  position: Position.optional(),
  foot: Foot.optional(),
  context: VideoContext.optional(),
  hashtags: z.array(Hashtag).max(10).default([]),
  visibility: Visibility.default('public'),
});

export const CreateUploadRequest = VideoDetails.extend({
  contentType: VideoContentType,
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  trimStartMs: z.number().int().min(0).optional(),
  trimEndMs: z.number().int().positive().optional(),
  challengeId: Id.optional(),
}).refine((v) => v.trimStartMs === undefined || v.trimEndMs === undefined || v.trimEndMs > v.trimStartMs, { message: 'trim end must be after trim start', path: ['trimEndMs'] });
export const CreateUploadResponse = z.object({
  videoId: Id,
  upload: z.object({ url: z.url(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()), expiresAt: z.iso.datetime() }),
});
export const UpdateVideoRequest = VideoDetails.partial().omit({ hashtags: true }).extend({ hashtags: z.array(Hashtag).max(10).optional() });

export const VideoTag = z.object({
  skill: SkillKey,
  name: Bilingual,
  source: z.enum(['ai', 'user']),
  /** AI confidence, 0..1. Null for tags the player added. */
  confidence: z.number().nullable(),
});
export const TagCorrectionRequest = z.object({
  add: z.array(SkillKey).max(10).default([]),
  /** Rejecting an AI tag hides it; the AI row is kept for audit. */
  reject: z.array(SkillKey).max(10).default([]),
});

export const OwnerSummary = z.object({
  userId: Id, handle: z.string(), displayName: z.string(), avatarUrl: z.string().nullable(), verified: z.boolean(), isDemo: z.boolean(),
});
export const VideoView = z.object({
  id: Id,
  owner: OwnerSummary,
  status: VideoStatus,
  /** Owner and staff only: why a video is not published. */
  statusReason: z.string().nullable(),
  moderation: ModerationVerdict.nullable(),
  title: z.string(),
  description: z.string().nullable(),
  skill: SkillKey.nullable(),
  position: Position.nullable(),
  foot: Foot.nullable(),
  context: VideoContext.nullable(),
  country: z.string().nullable(),
  visibility: Visibility,
  tags: z.array(VideoTag),
  hashtags: z.array(z.string()),
  playbackUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  likes: z.number().int(),
  comments: z.number().int(),
  saves: z.number().int(),
  likedByMe: z.boolean(),
  savedByMe: z.boolean(),
  createdAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
});
export const VideoPage = z.object({ items: z.array(VideoView), nextCursor: z.string().nullable() });

// ---------------------------------------------------------------- feed and social
export const FeedTab = z.enum(['for_you', 'following', 'new_talent', 'trending']);
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

export const ReportReason = z.enum(['spam', 'harassment', 'hate', 'sexual', 'violence', 'dangerous', 'child_safety',
  'impersonation', 'copyright', 'stolen_video', 'scam', 'not_football', 'other']);
export const ReportRequest = z.object({
  targetKind: z.enum(['video', 'comment', 'user']),
  targetId: Id,
  reason: ReportReason,
  details: z.string().max(1000).optional(),
});

// ---------------------------------------------------------------- players, search, discover
export const PlayerCard = z.object({
  userId: Id,
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  verified: z.boolean(),
  isDemo: z.boolean(),
  country: z.string().nullable(),
  position: Position.nullable(),
  foot: Foot.nullable(),
  /** Shown to verified scouts, staff and for adults only. */
  ageGroup: AgeBand.nullable(),
  followers: z.number().int(),
  videos: z.number().int(),
  topSkills: z.array(SkillKey),
});

export const SearchQuery = CursorQuery.extend({
  q: z.string().trim().max(100).optional(),
  type: z.enum(['all', 'players', 'videos', 'hashtags']).default('all'),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  position: Position.optional(),
  foot: Foot.optional(),
  skill: SkillKey.optional(),
  hashtag: z.string().max(41).optional(),
});
export const SearchResult = z.object({
  players: z.array(PlayerCard),
  videos: z.array(VideoView),
  hashtags: z.array(z.object({ tag: z.string(), videos: z.number().int() })),
});

export const RadarCategory = z.enum(['rising', 'most_watched', 'most_saved', 'new_talents', 'hidden_gems']);
export const RadarQuery = z.object({
  category: RadarCategory.default('rising'),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  position: Position.optional(),
  skill: SkillKey.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const RadarPage = z.object({
  category: RadarCategory,
  capability: Capability,
  /** Always shown with the radar: it measures attention, not ability. */
  disclaimer: Bilingual,
  items: z.array(z.object({ player: PlayerCard, reasons: z.array(z.object({ code: z.string(), text: Bilingual })) })),
});

export const ChallengeView = z.object({
  id: Id,
  slug: z.string(),
  title: Bilingual,
  description: Bilingual,
  skill: SkillKey.nullable(),
  hashtag: z.string().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  state: z.enum(['upcoming', 'active', 'ended']),
  entries: z.number().int(),
  isDemo: z.boolean(),
});
export const ChallengeList = z.object({ items: z.array(ChallengeView) });
export const CreateChallengeRequest = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,60}$/),
  title: Bilingual,
  description: Bilingual,
  skillKey: SkillKey.optional(),
  hashtag: Hashtag.optional(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
});
export const EnterChallengeRequest = z.object({ videoId: Id });

export const DiscoverView = z.object({
  skills: z.array(SkillView.extend({ videos: z.number().int() })),
  trendingHashtags: z.array(z.object({ tag: z.string(), videos: z.number().int() })),
  challenges: z.array(ChallengeView),
  risingPlayers: z.array(PlayerCard),
  latest: z.array(VideoView),
});

// ---------------------------------------------------------------- scouts
export const ScoutSearchQuery = CursorQuery.extend({
  q: z.string().trim().max(100).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  position: Position.optional(),
  foot: Foot.optional(),
  skill: SkillKey.optional(),
  ageGroup: AgeBand.optional(),
  verifiedOnly: z.coerce.boolean().optional(),
  minFollowers: z.coerce.number().int().min(0).optional(),
});
export const PlayerPage = z.object({ items: z.array(PlayerCard), nextCursor: z.string().nullable() });

export const ShortlistView = z.object({ id: Id, name: z.string(), players: z.number().int(), createdAt: z.iso.datetime() });
export const ShortlistList = z.object({ items: z.array(ShortlistView) });
export const ShortlistDetail = ShortlistView.extend({ items: z.array(PlayerCard.extend({ addedAt: z.iso.datetime() })) });
export const CreateShortlistRequest = z.object({ name: z.string().trim().min(1).max(80) });

export const ScoutNoteView = z.object({ id: Id, playerId: Id, body: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export const ScoutNoteList = z.object({ items: z.array(ScoutNoteView) });
export const CreateScoutNoteRequest = z.object({ body: z.string().trim().min(1).max(4000) });

export const ContactRequestCreate = z.object({ message: z.string().trim().min(10).max(1000) });
export const ContactRequestView = z.object({
  id: Id,
  scout: z.object({ userId: Id, handle: z.string(), displayName: z.string(), organization: z.string().nullable() }),
  player: z.object({ userId: Id, handle: z.string() }),
  /** True when this request was routed to a guardian because the player is a minor. */
  viaGuardian: z.boolean(),
  message: z.string(),
  status: z.enum(['pending', 'accepted', 'declined']),
  createdAt: z.iso.datetime(),
});
export const ContactRequestList = z.object({ items: z.array(ContactRequestView) });
export const ContactResponseRequest = z.object({ accept: z.boolean() });

export const VerificationRequestCreate = z.object({
  kind: z.enum(['player', 'scout']),
  organization: z.string().trim().min(2).max(120).optional(),
  evidence: z.string().trim().min(10).max(1000),
});
export const VerificationRequestView = z.object({
  id: Id,
  user: z.object({ userId: Id, handle: z.string(), displayName: z.string() }),
  kind: z.enum(['player', 'scout']),
  status: z.enum(['pending', 'approved', 'rejected']),
  organization: z.string().nullable(),
  evidence: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export const VerificationRequestList = z.object({ items: z.array(VerificationRequestView) });

// ---------------------------------------------------------------- notifications
export const NotificationView = z.object({
  id: Id,
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  read: z.boolean(),
  createdAt: z.iso.datetime(),
});
export const NotificationPage = z.object({ items: z.array(NotificationView), nextCursor: z.string().nullable() });
export const MarkReadRequest = z.object({ ids: z.array(Id).max(100).optional() });

// ---------------------------------------------------------------- admin
export const ModerationCaseView = z.object({
  id: Id,
  targetKind: z.enum(['video', 'comment', 'user']),
  targetId: Id,
  source: z.enum(['ai', 'rules', 'report', 'appeal']),
  categories: z.array(z.string()),
  aiVerdict: z.unknown().nullable(),
  reportCount: z.number().int(),
  priority: z.number().int(),
  status: z.enum(['open', 'actioned', 'dismissed']),
  decision: z.string().nullable(),
  createdAt: z.iso.datetime(),
  video: VideoView.nullable(),
  comment: z.object({ id: Id, body: z.string(), authorHandle: z.string() }).nullable(),
});
export const ModerationCaseList = z.object({ items: z.array(ModerationCaseView) });
export const ModerationCaseQuery = z.object({ status: z.enum(['open', 'actioned', 'dismissed']).default('open'), limit: z.coerce.number().int().min(1).max(100).default(50) });
export const ModerationDecisionRequest = z.object({
  /** escalate keeps the case open at top priority; suspend also suspends the owner's account. */
  decision: z.enum(['approve', 'reject', 'remove', 'restrict', 'escalate', 'suspend', 'dismiss']),
  note: z.string().trim().max(1000).optional(),
});
export const UserStatusRequest = z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().min(3).max(500) });
export const VerificationDecisionRequest = z.object({ approve: z.boolean() });
export const AuditLogView = z.object({
  id: z.string(), actorId: Id.nullable(), action: z.string(), targetKind: z.string().nullable(), targetId: Id.nullable(),
  metadata: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime(),
});
export const AuditLogPage = z.object({ items: z.array(AuditLogView) });
export const AdminStats = z.object({
  users: z.number().int(), players: z.number().int(), scouts: z.number().int(), videosPublished: z.number().int(),
  openCases: z.number().int(), pendingVerifications: z.number().int(), failedJobs: z.number().int(),
});
export const JurisdictionRuleRequest = z.object({
  minimumAge: z.number().int().min(13).max(21),
  guardianConsentAge: z.number().int().min(13).max(21),
  legallyReviewed: z.boolean(),
  source: z.string().max(500).optional(),
});
