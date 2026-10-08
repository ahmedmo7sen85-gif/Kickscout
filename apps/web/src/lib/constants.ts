/**
 * Enum values the UI needs at runtime. They are typed against the contracts and a unit test checks
 * they match the Zod enums exactly, so the client bundle does not have to ship Zod for them.
 */
import type {
  AgeBand, ConsentPurpose, RadarCategory, FeedTab, Foot, Position, ReportReason, SkillKey, VideoContentType, VideoContext, VideoStatus, Visibility,
} from './types';

export const POSITIONS = ['GK', 'CB', 'LB', 'RB', 'DM', 'CM', 'AM', 'LW', 'RW', 'ST'] as const satisfies readonly Position[];
export const FEET = ['left', 'right', 'both'] as const satisfies readonly Foot[];
export const SKILL_KEYS = [
  'dribbling', 'elastico', 'step_over', 'rainbow_flick', 'cruyff_turn', 'roulette', 'nutmeg', 'ball_control', 'first_touch',
  'juggling', 'passing', 'crossing', 'shooting', 'free_kick', 'volley', 'speed', 'one_v_one', 'freestyle', 'defending', 'goalkeeping',
] as const satisfies readonly SkillKey[];
export const AGE_BANDS = ['u13', 'u16', 'u18', 'adult'] as const satisfies readonly AgeBand[];
export const FEED_TABS = ['for_you', 'following', 'new_talent', 'trending'] as const satisfies readonly FeedTab[];
export const RADAR_CATEGORIES = ['rising', 'most_watched', 'most_saved', 'new_talents', 'hidden_gems'] as const satisfies readonly RadarCategory[];
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'dangerous', 'child_safety', 'impersonation',
  'copyright', 'stolen_video', 'scam', 'not_football', 'other'] as const satisfies readonly ReportReason[];
export const VIDEO_CONTENT_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const satisfies readonly VideoContentType[];
export const VIDEO_STATUSES = ['uploading', 'processing', 'analyzing', 'review_required', 'published', 'rejected', 'failed', 'deleted'] as const satisfies readonly VideoStatus[];
export const VIDEO_CONTEXTS = ['match', 'training', 'freestyle', 'challenge', 'other'] as const satisfies readonly VideoContext[];
export const VISIBILITIES = ['public', 'followers', 'private'] as const satisfies readonly Visibility[];
export const CONSENT_PURPOSES = ['account', 'public_profile', 'scout_contact', 'model_training'] as const satisfies readonly ConsentPurpose[];

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
