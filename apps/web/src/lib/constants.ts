/**
 * Enum values the UI needs at runtime. They are typed against the contracts and a unit test checks
 * they match the Zod enums exactly, so the client bundle does not have to ship Zod for them.
 */
import type {
  AgeBand, ConsentPurpose, RadarCategory, FeedTab, Foot, NotificationPreferenceKey, Position, ProfileVisibility, ReportReason, SkillKey,
  VideoContentType, VideoContext, VideoStatus, Visibility,
} from './types';

export const POSITIONS = ['GK', 'CB', 'LB', 'RB', 'WB', 'DM', 'CM', 'AM', 'LW', 'RW', 'FW', 'ST'] as const satisfies readonly Position[];
export const FEET = ['left', 'right', 'both'] as const satisfies readonly Foot[];
export const SKILL_KEYS = [
  'dribbling', 'elastico', 'step_over', 'rainbow_flick', 'cruyff_turn', 'roulette', 'nutmeg', 'ball_control', 'first_touch',
  'juggling', 'passing', 'crossing', 'shooting', 'free_kick', 'volley', 'speed', 'one_v_one', 'freestyle', 'defending', 'goalkeeping',
  'through_ball', 'long_range_shooting', 'finishing', 'acceleration', 'tackling', 'interception', 'reflexes', 'ball_mastery', 'skill_combo',
  'match_highlight', 'la_croqueta',
] as const satisfies readonly SkillKey[];
export const AGE_BANDS = ['u13', 'u16', 'u18', 'adult'] as const satisfies readonly AgeBand[];
export const FEED_TABS = ['for_you', 'following', 'new_talent', 'trending'] as const satisfies readonly FeedTab[];
export const RADAR_CATEGORIES = [
  'rising', 'most_watched', 'most_saved', 'new_talents', 'hidden_gems', 'most_improved', 'top_by_skill', 'new_to_platform', 'regional_standouts',
] as const satisfies readonly RadarCategory[];
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'dangerous', 'child_safety', 'impersonation',
  'copyright', 'stolen_video', 'scam', 'not_football', 'fake_scout', 'inappropriate_contact', 'other'] as const satisfies readonly ReportReason[];
export const VIDEO_CONTENT_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const satisfies readonly VideoContentType[];
export const VIDEO_STATUSES = ['uploading', 'processing', 'analyzing', 'review_required', 'published', 'rejected', 'failed', 'deleted'] as const satisfies readonly VideoStatus[];
/** Video categories (sent as `context`). */
export const VIDEO_CONTEXTS = ['skill', 'match', 'training', 'freestyle', 'challenge', 'goal', 'assist', 'save', 'one_v_one', 'tactical',
  'showcase', 'other'] as const satisfies readonly VideoContext[];
export const VISIBILITIES = ['public', 'followers', 'private'] as const satisfies readonly Visibility[];
export const CONSENT_PURPOSES = ['account', 'public_profile', 'scout_contact', 'model_training'] as const satisfies readonly ConsentPurpose[];
export const PROFILE_VISIBILITIES = ['public', 'unlisted', 'followers', 'private'] as const satisfies readonly ProfileVisibility[];
export const NOTIFICATION_PREFERENCE_KEYS = ['follower', 'like', 'comment', 'saveMilestone', 'challenge', 'scoutContact', 'shortlistActivity',
  'verification', 'announcements'] as const satisfies readonly NotificationPreferenceKey[];
/** Privacy toggles shown in Settings, in display order. */
export const PRIVACY_TOGGLES = ['allowScoutDiscovery', 'allowContactRequests', 'showCountry', 'showRegion', 'showAge'] as const;

/** Client-side hints only; the server checks the real file. Must equal the contract limits. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_DURATION_MS = 180_000;
export const MAX_HASHTAGS = 10;
export const HASHTAG_RE = /^[\p{L}\p{N}_]{1,40}$/u;
export const HANDLE_RE = /^[a-zA-Z0-9_.]{3,30}$/;

export function normalizeHashtag(raw: string): string | null {
  const tag = raw.trim().replace(/^#+/, '').toLowerCase();
  return HASHTAG_RE.test(tag) ? tag : null;
}
