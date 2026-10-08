/** WB = wing-back; FW = forward, for attackers who do not play as an out-and-out striker (ST). */
export const POSITIONS = ['GK', 'CB', 'LB', 'RB', 'WB', 'DM', 'CM', 'AM', 'LW', 'RW', 'FW', 'ST'] as const;
export type Position = (typeof POSITIONS)[number];

export const FEET = ['left', 'right', 'both'] as const;
export type Foot = (typeof FEET)[number];

/** Skill keys, matching the `skills` table seed. */
export const SKILL_KEYS = [
  'dribbling', 'elastico', 'step_over', 'rainbow_flick', 'cruyff_turn', 'roulette', 'nutmeg', 'ball_control',
  'first_touch', 'juggling', 'passing', 'crossing', 'shooting', 'free_kick', 'volley', 'speed', 'one_v_one',
  'freestyle', 'defending', 'goalkeeping', 'through_ball', 'long_range_shooting', 'finishing', 'acceleration', 'tackling',
  'interception', 'reflexes', 'ball_mastery', 'skill_combo', 'match_highlight', 'la_croqueta',
] as const;
export type SkillKey = (typeof SKILL_KEYS)[number];

/**
 * What kind of clip it is. Stored in `videos.context`; the first five original values
 * (match, training, freestyle, challenge, other) remain valid.
 */
export const VIDEO_CATEGORIES = [
  'skill', 'match', 'training', 'freestyle', 'challenge', 'goal', 'assist', 'save', 'one_v_one', 'tactical', 'showcase', 'other',
] as const;
export type VideoCategory = (typeof VIDEO_CATEGORIES)[number];

export const VIDEO_STATUSES = ['uploading', 'processing', 'analyzing', 'review_required', 'published', 'rejected', 'failed', 'deleted'] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const MODERATION_VERDICTS = ['safe', 'flagged', 'review_required', 'rejected'] as const;
export type ModerationVerdict = (typeof MODERATION_VERDICTS)[number];

/** Normalises a hashtag: strips '#', lowercases, keeps letters (any script), digits and underscore. */
export function normalizeHashtag(raw: string): string | null {
  const tag = raw.trim().replace(/^#+/, '').toLowerCase();
  return /^[\p{L}\p{N}_]{1,40}$/u.test(tag) ? tag : null;
}
