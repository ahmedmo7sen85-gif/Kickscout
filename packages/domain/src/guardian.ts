/**
 * KICKSCOUT Guardian: the football-relevance and content-safety rules every upload passes before it
 * can be public. The worker runs the scan (apps/worker/src/guardian); the API enforces the outcome.
 * Probabilities here describe the clip's content, never the player.
 */

export const SAFETY_STATUSES = ['PENDING_SCAN', 'PROCESSING', 'APPROVED', 'REJECTED', 'HUMAN_REVIEW', 'SCAN_FAILED', 'REMOVED'] as const;
export type SafetyStatus = (typeof SAFETY_STATUSES)[number];

/** What the classifiers can detect. */
export const GUARDIAN_CATEGORIES = [
  // child safety: the highest-priority workflow
  'child_sexual_content', 'sexual_exploitation',
  // sexual content
  'sexual_activity', 'pornography', 'nudity', 'suggestive',
  // other harms
  'harassment', 'hate', 'graphic_violence', 'dangerous', 'illegal', 'scam',
  // off-platform content
  'spam', 'advertising', 'gaming_footage', 'unrelated_entertainment',
] as const;
export type GuardianCategory = (typeof GUARDIAN_CATEGORIES)[number];

export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

export const CATEGORY_SEVERITY: Record<GuardianCategory, Severity> = {
  child_sexual_content: 'critical',
  sexual_exploitation: 'critical',
  sexual_activity: 'serious',
  pornography: 'serious',
  nudity: 'serious',
  graphic_violence: 'serious',
  hate: 'serious',
  illegal: 'serious',
  suggestive: 'moderate',
  harassment: 'moderate',
  dangerous: 'moderate',
  scam: 'moderate',
  spam: 'minor',
  advertising: 'minor',
  gaming_footage: 'minor',
  unrelated_entertainment: 'minor',
};

/** The sexual-content family: with a minor possibly involved, any signal here goes to the child-safety workflow. */
export const SEXUAL_CATEGORIES: ReadonlySet<GuardianCategory> = new Set(['sexual_activity', 'pornography', 'nudity', 'suggestive', 'sexual_exploitation', 'child_sexual_content']);

/** Machine-readable reasons recorded with every decision and shown to reviewers. */
export const REASON_CODES = [
  'FOOTBALL_CONFIRMED', 'NO_PROHIBITED_CONTENT',
  'NOT_FOOTBALL', 'FOOTBALL_UNCERTAIN', 'STATIC_IMAGE', 'FOOTBALL_PARTIAL',
  'PROHIBITED_CONTENT', 'POSSIBLE_PROHIBITED_CONTENT', 'DISGUISED_CONTENT', 'CHILD_SAFETY', 'MINOR_INVOLVED',
  'CONFLICTING_MODELS', 'LOW_CONFIDENCE', 'TEXT_SIGNAL', 'ON_SCREEN_TEXT_SIGNAL', 'AUDIO_NOT_CHECKED', 'AUDIO_SIGNAL',
  'REUPLOAD_OF_REJECTED', 'SIMILAR_TO_REJECTED', 'DUPLICATE_OF_OTHER_OWNER',
  'INTEGRITY_FAILED', 'CLASSIFIER_UNAVAILABLE', 'CLASSIFIER_REFUSED', 'CLASSIFIER_ERROR', 'SCAN_INCOMPLETE', 'BUDGET_EXCEEDED',
  'USER_REPORTS', 'POLICY_RESCAN',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

// ---------------------------------------------------------------- policy

export interface CategoryThresholds {
  /** At or above: a human looks before anything is published. */
  review: number;
  /** At or above (confirmed by the deep pass): rejected without waiting for a human. Null: never auto-rejected. */
  reject: number | null;
}

export interface GuardianPolicy {
  version: string;
  sampling: {
    /** Screening: one frame every `intervalMs` across the whole clip, within [minFrames, maxFrames]. */
    intervalMs: number;
    minFrames: number;
    maxFrames: number;
    /** Extra frames at scene cuts, so a short inserted scene is never skipped. 0 turns this off. */
    sceneThreshold: number;
    maxSceneFrames: number;
    /** Deep pass: frames every `deepStepMs` within `deepWindowMs` either side of each suspicious timestamp. */
    deepWindowMs: number;
    deepStepMs: number;
    deepMaxFrames: number;
    /** Frames sent to the deep model for skill tags when the screen found nothing. */
    taggingFrames: number;
    frameLongSide: number;
  };
  football: {
    /** Probability the clip is genuine football content needed to approve. */
    approveMin: number;
    /** At or below (with confidence): rejected as not football. */
    rejectMax: number;
    /** Share of sampled frames that must show football to approve (catches a few football seconds glued to something else). */
    minFrameShare: number;
  };
  /** Thresholds per severity; `categories` overrides single categories. */
  severity: Record<Severity, CategoryThresholds>;
  categories: Partial<Record<GuardianCategory, CategoryThresholds>>;
  /** Classifier confidence needed for any automatic decision (approve or reject). */
  minConfidence: number;
  /** A frame-level critical-category probability at or above this starts the child-safety workflow. */
  childSafetySignal: number;
  /** Text and caption signals at or above this send a visually clean clip to review (they never reject alone). */
  textReview: number;
  /** Hamming distance (of 64 bits) at which two frame hashes count as the same picture. */
  hashMaxDistance: number;
  /** Share of sampled frames (and at least `hashMinFrames`) matching a rejected video to count as a re-upload. */
  hashMinShare: number;
  hashMinFrames: number;
  /** Deep pass on every clip (it also suggests skill tags) or only when the screen finds a risk. */
  deepPass: 'always' | 'on_risk';
  /** Distinct open reports that pull a published video from public view pending review. */
  reportsToRestrict: number;
  /** Estimated AI spend per UTC day above which new scans fail closed to human review. 0: no cap. */
  dailyBudgetUsd: number;
}

export const DEFAULT_GUARDIAN_POLICY: GuardianPolicy = {
  version: '2026-10-09.1',
  sampling: {
    intervalMs: 2_000, minFrames: 8, maxFrames: 32, sceneThreshold: 0.3, maxSceneFrames: 12,
    deepWindowMs: 1_500, deepStepMs: 300, deepMaxFrames: 24, taggingFrames: 6, frameLongSide: 512,
  },
  football: { approveMin: 0.7, rejectMax: 0.15, minFrameShare: 0.5 },
  severity: {
    critical: { review: 0.05, reject: 0.5 },
    serious: { review: 0.3, reject: 0.85 },
    moderate: { review: 0.4, reject: null },
    minor: { review: 0.6, reject: null },
  },
  categories: {},
  minConfidence: 0.6,
  childSafetySignal: 0.2,
  textReview: 0.5,
  hashMaxDistance: 6,
  hashMinShare: 0.3,
  hashMinFrames: 3,
  deepPass: 'always',
  reportsToRestrict: 3,
  dailyBudgetUsd: 0,
};

export function thresholdsFor(policy: GuardianPolicy, category: GuardianCategory): CategoryThresholds {
  return policy.categories[category] ?? policy.severity[CATEGORY_SEVERITY[category]];
}

/** Deep-merges a partial override (from GUARDIAN_POLICY JSON) onto the defaults. Unknown keys are ignored. */
export function mergePolicy(base: GuardianPolicy, override: unknown): GuardianPolicy {
  if (!override || typeof override !== 'object') return base;
  const o = override as Record<string, unknown>;
  const pick = <T extends object>(b: T, v: unknown): T => {
    if (!v || typeof v !== 'object') return b;
    const out: Record<string, unknown> = { ...(b as Record<string, unknown>) };
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!(k in b)) continue;
      const cur = (b as Record<string, unknown>)[k];
      if (typeof cur === 'number' && typeof val === 'number' && Number.isFinite(val)) out[k] = val;
      else if (typeof cur === 'string' && typeof val === 'string') out[k] = val;
      // Only a category's `reject` may be null (never auto-reject) or switch from null to a number.
      else if (k === 'reject' && (val === null || (typeof val === 'number' && Number.isFinite(val)))) out[k] = val;
    }
    return out as unknown as T;
  };
  const severity = { ...base.severity };
  if (o.severity && typeof o.severity === 'object') {
    for (const s of Object.keys(severity) as Severity[]) severity[s] = pick(severity[s], (o.severity as Record<string, unknown>)[s]);
  }
  const categories: GuardianPolicy['categories'] = { ...base.categories };
  if (o.categories && typeof o.categories === 'object') {
    for (const [c, v] of Object.entries(o.categories as Record<string, unknown>)) {
      if ((GUARDIAN_CATEGORIES as readonly string[]).includes(c)) {
        categories[c as GuardianCategory] = pick(thresholdsFor(base, c as GuardianCategory), v);
      }
    }
  }
  const top = pick(
    { version: base.version, minConfidence: base.minConfidence, childSafetySignal: base.childSafetySignal, textReview: base.textReview,
      hashMaxDistance: base.hashMaxDistance, hashMinShare: base.hashMinShare, hashMinFrames: base.hashMinFrames,
      reportsToRestrict: base.reportsToRestrict, dailyBudgetUsd: base.dailyBudgetUsd },
    o,
  );
  return {
    ...base,
    ...top,
    deepPass: o.deepPass === 'on_risk' || o.deepPass === 'always' ? o.deepPass : base.deepPass,
    sampling: pick(base.sampling, o.sampling),
    football: pick(base.football, o.football),
    severity,
    categories,
  };
}

// ---------------------------------------------------------------- enforcement

export interface StrikeSummary {
  severity: Severity;
  createdAt: Date;
}

export type Enforcement =
  | { action: 'none' }
  | { action: 'restrict_uploads'; days: number }
  | { action: 'suspend' };

/** How long a strike counts, by severity. */
export const STRIKE_DAYS: Record<Severity, number> = { critical: 3650, serious: 180, moderate: 90, minor: 30 };

/**
 * Escalating enforcement from an account's active strikes (the newest one included). Any critical
 * strike suspends. Serious violations: 1st restricts uploads for 7 days, 2nd for 30, 3rd suspends.
 * Lesser violations add up more slowly. A paid plan changes nothing here.
 */
export function enforcementFor(strikes: readonly StrikeSummary[]): Enforcement {
  const count = (s: Severity) => strikes.filter((x) => x.severity === s).length;
  if (count('critical') > 0) return { action: 'suspend' };
  const serious = count('serious');
  const lesser = count('moderate') + count('minor') / 2;
  if (serious >= 3 || serious * 2 + lesser >= 8) return { action: 'suspend' };
  if (serious === 2) return { action: 'restrict_uploads', days: 30 };
  if (serious === 1) return { action: 'restrict_uploads', days: 7 };
  if (lesser >= 4) return { action: 'restrict_uploads', days: 7 };
  if (lesser >= 3) return { action: 'restrict_uploads', days: 1 };
  return { action: 'none' };
}

/** The most severe category in a list, or null when none is a Guardian category. */
export function worstSeverity(categories: readonly string[]): Severity | null {
  const order: Severity[] = ['critical', 'serious', 'moderate', 'minor'];
  for (const s of order) {
    if (categories.some((c) => (CATEGORY_SEVERITY as Record<string, Severity>)[c] === s)) return s;
  }
  return null;
}

/** Report reasons mapped to the Guardian category they allege (for case categories and strikes). */
export const REPORT_REASON_CATEGORY: Record<string, GuardianCategory | 'not_football' | null> = {
  sexual: 'sexual_activity', child_safety: 'child_sexual_content', violence: 'graphic_violence', hate: 'hate',
  harassment: 'harassment', dangerous: 'dangerous', scam: 'scam', spam: 'spam', not_football: 'not_football',
};
