/**
 * API contracts. These Zod schemas validate requests and responses in the API, generate the
 * OpenAPI document, and type the clients. Nothing is declared twice.
 */
import { z } from 'zod';

export const Id = z.uuid();
export const Locale = z.enum(['en', 'ar', 'es', 'pt', 'fr']);
export const Position = z.enum(['GK', 'CB', 'LB', 'RB', 'WB', 'DM', 'CM', 'AM', 'LW', 'RW', 'FW', 'ST']);
export const Foot = z.enum(['left', 'right', 'both']);
export const SkillKey = z.enum(['dribbling', 'elastico', 'step_over', 'rainbow_flick', 'cruyff_turn', 'roulette', 'nutmeg',
  'ball_control', 'first_touch', 'juggling', 'passing', 'crossing', 'shooting', 'free_kick', 'volley', 'speed', 'one_v_one',
  'freestyle', 'defending', 'goalkeeping', 'through_ball', 'long_range_shooting', 'finishing', 'acceleration', 'tackling',
  'interception', 'reflexes', 'ball_mastery', 'skill_combo', 'match_highlight', 'la_croqueta']);
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
/** What kind of clip it is. Sent and returned as `context` (the original field name); old values stay valid. */
export const VideoCategory = z.enum(['skill', 'match', 'training', 'freestyle', 'challenge', 'goal', 'assist', 'save', 'one_v_one',
  'tactical', 'showcase', 'other']);
export const VideoContext = VideoCategory;
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
  /** The uploader declares they own the clip or have the rights to post it. Required, recorded with a timestamp. */
  rightsConfirmed: z.literal(true, { error: 'confirm that you own this video or have the rights to post it' }),
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
  /** The model that suggested an AI tag. Shown to the owner and staff only; null otherwise and for player tags. */
  model: z.string().nullable().default(null),
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
/** "Why am I seeing this?" for one feed item. */
export const FeedWhy = z.object({ code: z.string(), text: Bilingual });
export const FeedPage = z.object({
  tab: FeedTab,
  capability: Capability,
  items: z.array(VideoView),
  nextCursor: z.string().nullable(),
  /** True when For You was ranked from the viewer's own signals (followed players, liked skills, country). */
  personalized: z.boolean().default(false),
  /** For You: the reason each item (by video id) is shown. */
  why: z.record(z.string(), FeedWhy).default({}),
});

// ---------------------------------------------------------------- recommendation controls
export const RecommendationSettingsView = z.object({
  /** The viewer's choice. */
  personalize: z.boolean(),
  /** Personalisation is switched on for the platform (FOR_YOU_PERSONALIZATION); when false For You is newest first for everyone. */
  available: z.boolean(),
  /** Likes and saves before this no longer shape the feed. */
  historyResetAt: z.iso.datetime().nullable(),
  notInterested: z.object({ videos: z.number().int(), players: z.number().int(), skills: z.array(SkillKey) }),
});
export const UpdateRecommendationSettingsRequest = z.object({ personalize: z.boolean() }).strict();

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
  'impersonation', 'copyright', 'stolen_video', 'scam', 'not_football', 'fake_scout', 'inappropriate_contact', 'other']);
/** Scouts are reported as users; clubs, academies and agencies as organizations. */
export const ReportRequest = z.object({
  targetKind: z.enum(['video', 'comment', 'user', 'organization']),
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

export const RadarCategory = z.enum(['rising', 'most_watched', 'most_saved', 'new_talents', 'hidden_gems', 'most_improved', 'top_by_skill',
  'new_to_platform', 'regional_standouts']);
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

/** identity: the person is who they say; organization: an organization on KICKSCOUT is real (asked by its owner or an admin). */
export const VerificationKind = z.enum(['identity', 'player', 'scout', 'organization']);
export const VerificationRequestCreate = z.object({
  kind: VerificationKind,
  /** The club, academy or agency a scout works for (free text). */
  organization: z.string().trim().min(2).max(120).optional(),
  /** Required for kind 'organization': the organization to verify. */
  organizationId: Id.optional(),
  evidence: z.string().trim().min(10).max(1000),
});
export const VerificationRequestView = z.object({
  id: Id,
  user: z.object({ userId: Id, handle: z.string(), displayName: z.string() }),
  kind: VerificationKind,
  status: z.enum(['pending', 'approved', 'rejected']),
  organization: z.string().nullable(),
  /** For kind 'organization': the organization being verified. */
  targetOrganization: z.object({ id: Id, name: z.string(), type: z.string(), country: z.string().nullable() }).nullable().default(null),
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

// ---------------------------------------------------------------- copyright
/** Public takedown request. `video` is the clip's link or id. Both statements must be affirmed. */
export const CopyrightTakedownRequest = z.object({
  claimantName: z.string().trim().min(2).max(120),
  email: z.email(),
  video: z.string().trim().min(1).max(500),
  description: z.string().trim().min(20).max(4000),
  goodFaith: z.literal(true, { error: 'you must state that you believe in good faith the use is not authorised' }),
  accurate: z.literal(true, { error: 'you must state that the information is accurate' }),
});
export const CopyrightTakedownResponse = z.object({ claimId: Id, status: z.literal('received') });
export const CounterNoticeRequest = z.object({
  fullName: z.string().trim().min(2).max(120),
  explanation: z.string().trim().min(20).max(4000),
  goodFaith: z.literal(true, { error: 'you must state that you believe in good faith the video was removed by mistake' }),
});
export const CopyrightClaimView = z.object({
  id: Id, claimantName: z.string(), claimantEmail: z.string(), description: z.string(),
  status: z.enum(['open', 'upheld', 'rejected', 'reversed']), createdAt: z.iso.datetime(),
});
export const CounterNoticeView = z.object({
  id: Id, fullName: z.string(), explanation: z.string(), status: z.enum(['pending', 'accepted', 'rejected']), createdAt: z.iso.datetime(),
});

// ---------------------------------------------------------------- privacy, notifications, account
export const ProfileVisibility = z.enum(['public', 'unlisted', 'followers', 'private']);
export const PrivacySettingsView = z.object({
  subjectId: Id,
  /** 'unlisted': opens by direct link, never listed in feeds, search, Discover, Talent Radar or scout search. */
  profileVisibility: ProfileVisibility,
  regionPrecision: z.enum(['macro', 'country', 'city']),
  comments: z.enum(['everyone', 'followers', 'off']),
  allowScoutDiscovery: z.boolean(),
  allowContactRequests: z.boolean(),
  showCountry: z.boolean(),
  showRegion: z.boolean(),
  showAge: z.boolean(),
  /** Off: only strictly necessary product-analytics events are recorded (billing and safety). */
  allowAnalytics: z.boolean(),
  /** True for minors: stricter rules apply whatever these settings say, and only the guardian can loosen them. */
  minorProtections: z.boolean(),
});
export const UpdatePrivacyRequest = PrivacySettingsView.omit({ subjectId: true, minorProtections: true }).partial();

export const NotificationPreferencesView = z.object({
  follower: z.boolean(),
  like: z.boolean(),
  comment: z.boolean(),
  saveMilestone: z.boolean(),
  challenge: z.boolean(),
  scoutContact: z.boolean(),
  shortlistActivity: z.boolean(),
  verification: z.boolean(),
  announcements: z.boolean(),
  /** Security, safety and moderation notices cannot be turned off. */
  security: z.literal(true),
});
export const UpdateNotificationPreferencesRequest = NotificationPreferencesView.omit({ security: true }).partial().strict();

/** Explicit confirmation: the client must send the word DELETE. */
export const DeleteAccountRequest = z.object({ confirm: z.literal('DELETE', { error: 'type DELETE to confirm' }) });
export const DeleteAccountResponse = z.object({
  /** 'pending_guardian': a minor asked; the account is hidden until their guardian confirms. */
  status: z.enum(['deleted', 'pending_guardian']),
});

/** Everything KICKSCOUT holds that belongs to the caller. Never another user's private data. */
export const AccountExport = z.object({
  exportedAt: z.iso.datetime(),
  account: z.object({
    userId: Id, email: z.string().nullable(), status: z.string(), locale: z.string(), roles: z.array(z.string()), createdAt: z.iso.datetime(),
    ageGroup: AgeBand.nullable(), countryCode: z.string().nullable(), dateOfBirth: z.string().nullable(),
  }),
  profile: z.object({
    handle: z.string(), displayName: z.string(), bio: z.string().nullable(), regionCode: z.string().nullable(), verified: z.boolean(),
    player: PlayerFacts.nullable(),
  }).nullable(),
  settings: z.object({ privacy: PrivacySettingsView.nullable(), notifications: NotificationPreferencesView }),
  consents: z.array(z.object({ purpose: ConsentPurpose, granted: z.boolean(), grantedBy: z.enum(['self', 'guardian']), policyVersion: z.string(), at: z.iso.datetime() })),
  videos: z.array(z.object({
    id: Id, title: z.string(), description: z.string().nullable(), status: z.string(), visibility: z.string(), context: z.string().nullable(),
    skill: z.string().nullable(), position: z.string().nullable(), foot: z.string().nullable(), hashtags: z.array(z.string()),
    rightsConfirmedAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(), publishedAt: z.iso.datetime().nullable(),
  })),
  comments: z.array(z.object({ id: Id, videoId: Id, body: z.string(), status: z.string(), createdAt: z.iso.datetime() })),
  following: z.array(z.object({ userId: Id, handle: z.string(), since: z.iso.datetime() })),
  followers: z.object({ count: z.number().int() }),
  likes: z.array(z.object({ videoId: Id, at: z.iso.datetime() })),
  saves: z.array(z.object({ videoId: Id, at: z.iso.datetime() })),
  notifications: z.array(z.object({ id: Id, kind: z.string(), payload: z.record(z.string(), z.unknown()), read: z.boolean(), createdAt: z.iso.datetime() })),
  /** Plans in effect and subscription history. No provider ids, card or payment details. */
  billing: z.object({
    plans: z.array(z.string()),
    subscriptions: z.array(z.object({
      planKey: z.string(), planName: Bilingual, status: z.string(),
      /** subscriber: yours and paid by you; beneficiary: paid by your guardian; payer: you pay for someone else. */
      role: z.enum(['subscriber', 'beneficiary', 'payer']),
      interval: z.string().nullable(), currency: z.string().nullable(), amountMinor: z.number().int().nullable(),
      trialEnd: z.iso.datetime().nullable(), currentPeriodEnd: z.iso.datetime().nullable(), cancelAtPeriodEnd: z.boolean(),
      canceledAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(),
    })),
    couponRedemptions: z.array(z.object({ code: z.string(), at: z.iso.datetime() })),
  }),
  recommendations: z.object({
    personalize: z.boolean(),
    historyResetAt: z.iso.datetime().nullable(),
    notInterested: z.array(z.object({ kind: z.enum(['video', 'player', 'skill']), id: z.string(), at: z.iso.datetime() })),
  }).nullable().default(null),
  scout: z.object({
    shortlists: z.array(z.object({ id: Id, name: z.string(), playerIds: z.array(Id), createdAt: z.iso.datetime() })),
    notes: z.array(z.object({ id: Id, playerId: Id, body: z.string(), createdAt: z.iso.datetime() })),
  }).nullable(),
});

// ---------------------------------------------------------------- admin
export const ModerationCaseView = z.object({
  id: Id,
  targetKind: z.enum(['video', 'comment', 'user', 'organization']),
  targetId: Id,
  source: z.enum(['ai', 'rules', 'report', 'appeal', 'copyright']),
  categories: z.array(z.string()),
  aiVerdict: z.unknown().nullable(),
  /** The model version behind the AI analysis of the target video. */
  aiModel: z.string().nullable().default(null),
  reportCount: z.number().int(),
  priority: z.number().int(),
  status: z.enum(['open', 'actioned', 'dismissed']),
  decision: z.string().nullable(),
  createdAt: z.iso.datetime(),
  video: VideoView.nullable(),
  comment: z.object({ id: Id, body: z.string(), authorHandle: z.string() }).nullable(),
  /** For reports about an organization. */
  organization: z.object({ id: Id, name: z.string(), type: z.string(), verified: z.boolean(), status: z.string() }).nullable().default(null),
  /** Takedown claims on the target video, newest first. Claimant contact details are for staff only. */
  copyrightClaims: z.array(CopyrightClaimView),
  counterNotice: CounterNoticeView.nullable(),
  /** Upheld copyright claims against the owner of the target (distinct videos): the repeat-infringer count. */
  ownerCopyrightStrikes: z.number().int().nullable(),
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

// ---------------------------------------------------------------- organizations (phase D)
export const OrgType = z.enum(['academy', 'club', 'agency', 'school', 'other']);
export const OrgRole = z.enum(['owner', 'admin', 'scout', 'analyst', 'viewer']);
/** Ownership is never granted by invitation or role change, only by transfer. */
export const InvitableOrgRole = z.enum(['admin', 'scout', 'analyst', 'viewer']);
export const CountryCode = z.string().regex(/^[A-Z]{2}$/);
/** Logo object keys live under the organization's own prefix. Uploading logos is not built yet. */
export const OrgLogoKey = z.string().regex(/^org-logos\/[0-9a-f-]{36}\/[a-z0-9_-]{1,64}\.(?:png|jpg|jpeg|webp)$/);

export const CreateOrganizationRequest = z.object({
  name: z.string().trim().min(2).max(120),
  type: OrgType,
  countryCode: CountryCode.optional(),
});
export const UpdateOrganizationRequest = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  type: OrgType.optional(),
  countryCode: CountryCode.nullable().optional(),
  logoKey: OrgLogoKey.nullable().optional(),
});
/** What anyone may see. Members are never listed publicly. */
export const OrganizationPublicView = z.object({
  id: Id,
  name: z.string(),
  type: OrgType,
  country: z.string().nullable(),
  verified: z.boolean(),
  logoKey: z.string().nullable(),
  logoUrl: z.string().nullable(),
  /** The caller's role, when they are a member. */
  myRole: OrgRole.nullable(),
});
export const OrganizationMemberView = z.object({
  userId: Id, handle: z.string(), displayName: z.string(), role: OrgRole, since: z.iso.datetime(),
});
export const OrganizationInvitationView = z.object({
  id: Id, email: z.string(), role: InvitableOrgRole, status: z.enum(['pending', 'accepted', 'declined', 'revoked', 'expired']),
  expiresAt: z.iso.datetime(), createdAt: z.iso.datetime(),
});
export const OrganizationDashboard = OrganizationPublicView.extend({
  myRole: OrgRole,
  /** 'suspended': hidden from the public by a moderation decision; the pipeline is read-only meanwhile. */
  status: z.enum(['active', 'suspended']),
  members: z.array(OrganizationMemberView),
  /** Pending invitations; empty unless the caller is an admin or the owner. */
  invitations: z.array(OrganizationInvitationView),
  verification: z.object({ status: z.enum(['none', 'pending', 'approved', 'rejected']), requestedAt: z.iso.datetime().nullable() }),
  createdAt: z.iso.datetime(),
});
export const MyOrganizations = z.object({ items: z.array(OrganizationPublicView.extend({ myRole: OrgRole, suspended: z.boolean() })) });
export const CreateOrgInvitationRequest = z.object({ email: z.email(), role: InvitableOrgRole });
export const CreateOrgInvitationResponse = z.object({ invitationId: Id, expiresAt: z.iso.datetime() });
export const OrgInvitationTokenRequest = z.object({ token: z.string().min(32).max(200) });
export const AcceptOrgInvitationResponse = z.object({ organizationId: Id, role: InvitableOrgRole });
export const UpdateOrgMemberRequest = z.object({ role: InvitableOrgRole });
export const TransferOwnershipRequest = z.object({ userId: Id });
/** Deleting an organization erases its pipeline, notes and saved searches. The client must send DELETE. */
export const DeleteOrganizationRequest = z.object({ confirm: z.literal('DELETE', { error: 'type DELETE to confirm' }) });

// ---------------------------------------------------------------- scout CRM (phase D)
export const CrmStage = z.enum(['new', 'watching', 'shortlisted', 'monitoring', 'contact_requested', 'contacted', 'evaluation', 'archived']);
/** Stages a card can be placed in directly; contact stages are reached through the contact-request flow. */
export const DirectCrmStage = z.enum(['new', 'watching', 'shortlisted', 'monitoring', 'archived']);
export const CrmTag = z.string().trim().min(1).max(32);
export const CrmEntryView = z.object({
  id: Id,
  player: PlayerCard,
  stage: CrmStage,
  tags: z.array(z.string()),
  contactRequest: z.object({ id: Id, status: z.enum(['pending', 'accepted', 'declined']), viaGuardian: z.boolean() }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const PipelineQuery = z.object({ stage: CrmStage.optional(), tag: CrmTag.optional() });
export const PipelineView = z.object({ stages: z.array(CrmStage), items: z.array(CrmEntryView) });
export const AddToPipelineRequest = z.object({ stage: DirectCrmStage.default('new'), tags: z.array(CrmTag).max(20).default([]) });
export const CrmStageChangeRequest = z.object({
  stage: CrmStage,
  /** Required when moving to contact_requested: the message sent to the player, or to their guardian. */
  message: z.string().trim().min(10).max(1000).optional(),
});
export const UpdateCrmEntryRequest = z.object({ tags: z.array(CrmTag).max(20) });
export const CrmNoteView = z.object({
  id: Id, body: z.string(), author: z.object({ userId: Id, handle: z.string() }).nullable(), createdAt: z.iso.datetime(),
});
export const CreateCrmNoteRequest = z.object({ body: z.string().trim().min(1).max(4000) });
export const CrmEntryDetail = CrmEntryView.extend({
  history: z.array(z.object({
    from: CrmStage.nullable(), to: CrmStage, changedBy: z.object({ userId: Id, handle: z.string() }).nullable(), at: z.iso.datetime(),
  })),
  notes: z.array(CrmNoteView),
});

/** Saved-search filters are scout-search filters (the same schema, without paging). */
export const SavedSearchFilters = ScoutSearchQuery.omit({ cursor: true, limit: true });

/** Natural-language scout search: free text in, the same structured filters out, then the normal search. */
export const NlScoutSearchRequest = z.object({
  query: z.string().trim().min(1).max(300),
  limit: z.number().int().min(1).max(50).default(20),
});
export const NlScoutSearchResponse = z.object({
  /** Exactly what was searched: valid scout-search filters, editable and re-runnable with GET /v1/scout/players. */
  filters: SavedSearchFilters,
  /** 'ai': read by the AI model; 'rules': the built-in parser (no AI configured, or the AI answer was unusable). */
  parser: z.enum(['ai', 'rules']),
  model: z.string().nullable(),
  /** Built from the filters, never from model text. */
  explanation: Bilingual,
  results: PlayerPage,
});
export const CreateSavedSearchRequest = z.object({
  name: z.string().trim().min(1).max(80),
  filters: SavedSearchFilters,
  alerts: z.boolean().default(false),
});
export const UpdateSavedSearchRequest = z.object({ name: z.string().trim().min(1).max(80).optional(), alerts: z.boolean().optional() });
export const SavedSearchView = z.object({
  id: Id,
  name: z.string(),
  filters: z.record(z.string(), z.unknown()),
  alerts: z.boolean(),
  /** Clips alerted so far. */
  matches: z.number().int(),
  createdBy: z.object({ userId: Id, handle: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
});
export const SavedSearchList = z.object({ items: z.array(SavedSearchView) });
// ---------------------------------------------------------------- plans, entitlements, billing
export const Currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. USD');
export const BillingInterval = z.enum(['month', 'year']);
export const PlanAudience = z.enum(['player', 'scout', 'organization']);
export const PlanKey = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
export const PlanLimits = z.object({
  maxVideoSeconds: z.number().int(),
  maxActiveVideos: z.number().int(),
  maxUploadsPerDay: z.number().int(),
  /** null: unlimited. */
  scoutSearchesPerMonth: z.number().int().nullable(),
  shortlistSlots: z.number().int().nullable(),
  seats: z.number().int(),
});
/** Prices are in minor units (cents for USD), exactly what the payment provider will charge. */
export const PlanPrice = z.object({ currency: Currency, interval: BillingInterval, amountMinor: z.number().int() });
export const PlanFeature = z.object({ key: z.string(), status: z.enum(['live', 'coming_soon']) });
export const PlanView = z.object({
  key: PlanKey,
  audience: PlanAudience,
  tier: z.enum(['free', 'pro', 'organization', 'club', 'enterprise']),
  name: Bilingual,
  description: Bilingual,
  /** none: free; self_serve: Checkout; contact_sales: no checkout. */
  checkout: z.enum(['none', 'self_serve', 'contact_sales']),
  trialDays: z.number().int(),
  prices: z.array(PlanPrice),
  features: z.array(PlanFeature),
  limits: PlanLimits,
});
export const PlansQuery = z.object({ currency: Currency.default('USD') });
export const PlanList = z.object({
  currency: Currency,
  /** False until the payment provider is configured; checkout then answers 503 BILLING_NOT_CONFIGURED. */
  paymentsEnabled: z.boolean(),
  items: z.array(PlanView),
});

export const SubscriptionView = z.object({
  planKey: PlanKey,
  planName: Bilingual,
  status: z.enum(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']),
  interval: BillingInterval.nullable(),
  currency: Currency.nullable(),
  amountMinor: z.number().int().nullable(),
  trialEnd: z.iso.datetime().nullable(),
  currentPeriodEnd: z.iso.datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  /** True when the plan is in effect now. */
  grantsAccess: z.boolean(),
  /** Paid by someone else (a guardian). */
  paidByOther: z.boolean(),
});
export const EntitlementsView = z.object({
  plans: z.array(PlanKey),
  features: z.array(z.string()),
  limits: PlanLimits,
  usage: z.object({
    activeVideos: z.number().int(),
    uploadsToday: z.number().int(),
    scoutSearchesThisMonth: z.number().int(),
    shortlistSlotsUsed: z.number().int(),
    /** When the monthly search quota starts again. */
    searchesResetAt: z.iso.datetime(),
  }),
  subscriptions: z.array(SubscriptionView),
  /** The caller has a billing account with the provider, so the billing portal can open. */
  hasBillingAccount: z.boolean(),
  paymentsEnabled: z.boolean(),
});

export const CouponCode = z.string().trim().regex(/^[a-zA-Z0-9_-]{3,40}$/, 'letters, digits, _ and - (3 to 40)');
export const CheckoutRequest = z.object({
  planKey: PlanKey,
  interval: BillingInterval,
  currency: Currency.default('USD'),
  couponCode: CouponCode.optional(),
  /** A guardian buying for their ward. Omit to buy for yourself. */
  forUserId: Id.optional(),
});
export const CheckoutResponse = z.object({
  /** The payment provider's hosted checkout page. Nothing is granted until the provider confirms payment. */
  url: z.url(),
  sessionId: z.string(),
  planKey: PlanKey,
  interval: BillingInterval,
  currency: Currency,
  amountMinor: z.number().int(),
  trialDays: z.number().int(),
});
export const PortalResponse = z.object({ url: z.url() });
export const CouponValidateRequest = z.object({ code: CouponCode, planKey: PlanKey, currency: Currency.default('USD') });
export const CouponView = z.object({
  code: z.string(),
  kind: z.enum(['coupon', 'referral']),
  percentOff: z.number().int().nullable(),
  amountOffMinor: z.number().int().nullable(),
  currency: Currency.nullable(),
  duration: z.enum(['once', 'repeating', 'forever']),
  durationMonths: z.number().int().nullable(),
});
export const WebhookAck = z.object({ received: z.literal(true), duplicate: z.boolean() });
export const BillingMaintenanceReport = z.object({ canceled: z.number().int(), failed: z.number().int(), pending: z.number().int() });

// ---------------------------------------------------------------- AI usage (admin)
export const AiUsageQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
export const AiUsageView = z.object({
  since: z.iso.datetime(),
  /** Whether an AI provider is configured on this API instance. */
  available: z.boolean(),
  routes: z.array(z.object({ task: z.string(), tier: z.string(), model: z.string(), effort: z.string(), maxTokens: z.number().int(), timeoutMs: z.number().int() })),
  items: z.array(z.object({
    task: z.string(), model: z.string(), calls: z.number().int(), ok: z.number().int(), failed: z.number().int(),
    inputTokens: z.number().int(), outputTokens: z.number().int(), avgLatencyMs: z.number().int(),
  })),
});
