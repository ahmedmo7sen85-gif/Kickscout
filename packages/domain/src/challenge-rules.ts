/**
 * Challenge lifecycle, submission states, eligibility and the observable checks a clip must pass.
 * Pure rules shared by the API, the worker and the web app.
 */
import type { AgeBand } from './age.js';
import { isMinor } from './age.js';
import type { Actor } from './policy.js';

// ---------------------------------------------------------------- lifecycle

export const CHALLENGE_STATUSES = ['draft', 'scheduled', 'active', 'judging', 'completed', 'archived', 'paused', 'cancelled'] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];
export const CHALLENGE_DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'expert'] as const;
export type ChallengeDifficulty = (typeof CHALLENGE_DIFFICULTIES)[number];
export const CHALLENGE_CATEGORIES = ['ball_control', 'dribbling', 'first_touch', 'freestyle', 'shooting', 'weak_foot', 'combo'] as const;
export type ChallengeCategory = (typeof CHALLENGE_CATEGORIES)[number];
export const CHALLENGE_FORMATS = ['standard', 'daily', 'weekly', 'monthly_cup', 'beat_my_skill'] as const;
export type ChallengeFormat = (typeof CHALLENGE_FORMATS)[number];

/** What a viewer sees. `open` is the only phase that takes new entries. */
export type ChallengePhase = 'draft' | 'upcoming' | 'open' | 'judging' | 'completed' | 'paused' | 'cancelled' | 'archived';

export interface ChallengeTiming {
  status: ChallengeStatus;
  startsAt: Date;
  endsAt: Date;
}

export function challengePhase(c: ChallengeTiming, now: Date): ChallengePhase {
  switch (c.status) {
    case 'draft': case 'paused': case 'cancelled': case 'archived': case 'completed': case 'judging':
      return c.status;
    case 'scheduled':
    case 'active':
      if (now < c.startsAt) return 'upcoming';
      return now < c.endsAt ? 'open' : 'judging';
  }
}

/** Listed and reachable by anyone (subject to its own visibility). Drafts, templates and archives are staff-only. */
export function isPubliclyVisible(c: { status: ChallengeStatus; isTemplate: boolean }): boolean {
  return !c.isTemplate && c.status !== 'draft' && c.status !== 'archived';
}

/** Uploads started before the deadline may finish arriving for this long. */
export const UPLOAD_GRACE_MS = 2 * 3_600_000;

export type AdminTransition = 'publish' | 'pause' | 'resume' | 'cancel' | 'close' | 'complete' | 'archive';

/** The status an admin action leads to from `from`, or null when it is not allowed. */
export function adminTransition(action: AdminTransition, c: ChallengeTiming, now: Date): ChallengeStatus | null {
  const byDates = (): ChallengeStatus => (now < c.startsAt ? 'scheduled' : now < c.endsAt ? 'active' : 'judging');
  switch (action) {
    case 'publish': return c.status === 'draft' && c.endsAt > now ? byDates() : null;
    case 'pause': return c.status === 'scheduled' || c.status === 'active' ? 'paused' : null;
    case 'resume': return c.status === 'paused' ? byDates() : null;
    case 'cancel': return ['draft', 'scheduled', 'active', 'paused', 'judging'].includes(c.status) ? 'cancelled' : null;
    case 'close': return c.status === 'active' ? 'judging' : null;
    case 'complete': return c.status === 'judging' ? 'completed' : null;
    case 'archive': return c.status === 'completed' || c.status === 'cancelled' ? 'archived' : null;
  }
}

/** The move the Operations Agent makes on its own as time passes, if any. */
export function scheduledTransition(c: ChallengeTiming, now: Date): ChallengeStatus | null {
  if (c.status === 'scheduled' && now >= c.startsAt) return now < c.endsAt ? 'active' : 'judging';
  if (c.status === 'active' && now >= c.endsAt) return 'judging';
  return null;
}

// ---------------------------------------------------------------- submissions

export const SUBMISSION_STATES = [
  'pending_upload', 'processing', 'pending_moderation', 'pending_judging', 'approved', 'rejected', 'disqualified', 'failed_processing', 'withdrawn',
] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/**
 * Where a submission stands given its video. The video safety pipeline owns the video's status;
 * any status it uses that is not listed here keeps the entry waiting in moderation.
 * `published` maps to null: the Verification Agent decides between judging and rejection.
 */
export function stateFromVideo(videoStatus: string): SubmissionState | null {
  switch (videoStatus) {
    case 'uploading': return 'pending_upload';
    case 'processing': case 'analyzing': return 'processing';
    case 'published': return null;
    case 'rejected': case 'removed': return 'rejected';
    case 'failed': case 'scan_failed': return 'failed_processing';
    case 'deleted': return 'withdrawn';
    default: return 'pending_moderation';
  }
}

/** States a judge or admin has settled; the video can still pull an entry out (removal, deletion). */
export const JUDGED_STATES: readonly SubmissionState[] = ['approved', 'disqualified'];
export const FINAL_STATES: readonly SubmissionState[] = ['withdrawn'];
/** Entries still on their way to a result. */
export const IN_FLIGHT_STATES: readonly SubmissionState[] = ['pending_upload', 'processing', 'pending_moderation', 'pending_judging'];

/** Whether an entry uses up one of the player's attempts. */
export function countsAsAttempt(state: SubmissionState, retryFailed: boolean): boolean {
  if (state === 'withdrawn') return false;
  if (retryFailed && (state === 'failed_processing' || state === 'rejected')) return false;
  return true;
}

// ---------------------------------------------------------------- eligibility

export interface EligibilityInput {
  actor: Pick<Actor, 'status' | 'ageBand' | 'roles'>;
  challenge: {
    phase: ChallengePhase;
    ageGroups: readonly AgeBand[];
    difficulty: ChallengeDifficulty;
    hasSafetyNotes: boolean;
    requiresPartner: boolean;
    attemptLimit: number;
  };
  participation: { status: 'active' | 'withdrawn' | 'disqualified' } | null;
  attemptsUsed: number;
  /** The entrant says someone else appears in the clip. */
  othersInClip: boolean;
  consentOthers: boolean;
  safetyAck: boolean;
}

export type Eligibility = { allowed: true } | { allowed: false; code: string; reason: string };

export function needsSafetyAck(c: { difficulty: ChallengeDifficulty; hasSafetyNotes: boolean }): boolean {
  return c.hasSafetyNotes || c.difficulty === 'advanced' || c.difficulty === 'expert';
}

/** Whether `actor` may enter one more clip. Account and role checks run first in `can()`. */
export function checkEligibility(i: EligibilityInput): Eligibility {
  const no = (code: string, reason: string): Eligibility => ({ allowed: false, code, reason });
  if (i.challenge.phase !== 'open') return no('CHALLENGE_NOT_OPEN', 'this challenge is not open');
  if (!i.challenge.ageGroups.includes(i.actor.ageBand)) return no('AGE_GROUP_NOT_ELIGIBLE', 'this challenge is for another age group');
  if (i.participation && i.participation.status !== 'active') return no('PARTICIPATION_CLOSED', `your participation is ${i.participation.status}`);
  if (i.attemptsUsed >= i.challenge.attemptLimit) return no('ATTEMPTS_USED', `you have used all ${i.challenge.attemptLimit} attempts`);
  if ((i.challenge.requiresPartner || i.othersInClip) && !i.consentOthers) return no('CONSENT_OTHERS_REQUIRED', 'confirm that everyone else in the clip agreed to appear');
  if (needsSafetyAck(i.challenge) && !i.safetyAck) return no('SAFETY_ACK_REQUIRED', 'read and accept the safety notes first');
  return { allowed: true };
}

// ---------------------------------------------------------------- verification (observable checks only)

export interface VerificationInput {
  durationMs: number | null;
  minDurationS: number;
  maxDurationS: number;
  videoCreatedAt: Date;
  startsAt: Date;
  endsAt: Date;
  /** A byte-identical clip from another entrant in any challenge. */
  duplicateOfOtherEntrant: boolean;
  /** The safety pipeline's football flag; null when it did not say. */
  footballPresent: boolean | null;
}

export interface VerificationCheck {
  key: 'duration' | 'recorded_in_window' | 'original' | 'football';
  pass: boolean | null;
  detail?: string;
}

/**
 * The Verification Agent checks only what the platform can observe: the real clip length from the
 * worker's probe, that the upload started inside the challenge window, that the file is not another
 * entrant's, and the safety pipeline's football flag. Whether the skill was done right is for judges.
 */
export function verifySubmission(i: VerificationInput): { pass: boolean; checks: VerificationCheck[]; reason: string | null } {
  const checks: VerificationCheck[] = [];
  if (i.durationMs === null) checks.push({ key: 'duration', pass: null, detail: 'length unknown' });
  else {
    const s = i.durationMs / 1000;
    checks.push({ key: 'duration', pass: s >= i.minDurationS - 0.5 && s <= i.maxDurationS + 0.5, detail: `${s.toFixed(1)} s` });
  }
  checks.push({ key: 'recorded_in_window', pass: i.videoCreatedAt >= i.startsAt && i.videoCreatedAt < i.endsAt });
  checks.push({ key: 'original', pass: !i.duplicateOfOtherEntrant });
  // A published clip has already passed the safety pipeline (possibly a human reviewer): a missing
  // football flag is shown to judges, never used to overrule that decision.
  checks.push({ key: 'football', pass: i.footballPresent === true ? true : null, ...(i.footballPresent === false ? { detail: 'not detected by the safety pipeline' } : {}) });
  const failed = checks.find((c) => c.pass === false);
  const reasons: Record<Exclude<VerificationCheck['key'], 'football'>, string> = {
    duration: `The clip must be between ${i.minDurationS} and ${i.maxDurationS} seconds long.`,
    recorded_in_window: 'The clip must be uploaded while the challenge is open.',
    original: 'This clip matches another player’s entry.',
  };
  return { pass: !failed, checks, reason: failed && failed.key !== 'football' ? reasons[failed.key] : null };
}

/** Age groups a minor can be grouped with on a leaderboard scope; adults compete with adults. */
export function competitionGroup(band: AgeBand): 'youth' | 'adult' {
  return isMinor(band) ? 'youth' : 'adult';
}
