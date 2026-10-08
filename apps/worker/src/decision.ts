import { SEVERE_CATEGORIES } from './analyzer/types.js';
import type { AnalysisOutcome } from './analyzer/types.js';

/** Skill tags below this confidence are dropped; those kept are shown as AI suggestions, never as fact. */
export const MIN_TAG_CONFIDENCE = 0.4;

export interface DecisionContext {
  /** Owner's age band is not 'adult' (or unknown). */
  ownerIsMinor: boolean;
  /** Another user already uploaded a byte-identical file. */
  duplicateOfOtherOwner: boolean;
}

export type Decision =
  | { status: 'published'; moderation: 'safe'; reason: null; case: null }
  | {
      status: 'review_required' | 'rejected';
      moderation: 'safe' | 'flagged' | 'review_required' | 'rejected' | null;
      reason: string;
      /** Open a moderation case for a human, or null when none is needed. */
      case: { categories: string[]; priority: number } | null;
    };

function priorityFor(categories: string[], ctx: DecisionContext): number {
  if (ctx.ownerIsMinor || categories.includes('child_safety')) return 0;
  if (categories.some((c) => SEVERE_CATEGORIES.has(c) || c === 'stolen_video')) return 1;
  return 2;
}

const withDuplicate = (categories: string[], ctx: DecisionContext) =>
  ctx.duplicateOfOtherOwner && !categories.includes('stolen_video') ? [...categories, 'stolen_video'] : categories;

const REVIEW_REASON = 'Your video is waiting for a moderator to check it before it is shown publicly.';

/**
 * Turns the AI outcome into a publication decision. Only clearly safe football content is published without a
 * human, only clear severe violations are rejected without one, and everything in between waits for review.
 * `outcome` null means no AI is configured.
 */
export function decide(outcome: AnalysisOutcome | null, ctx: DecisionContext): Decision {
  if (outcome === null) {
    const categories = withDuplicate(['ai_unavailable'], ctx);
    return { status: 'review_required', moderation: null, reason: REVIEW_REASON, case: { categories, priority: priorityFor(categories, ctx) } };
  }
  if (outcome.kind === 'refusal') {
    const categories = withDuplicate(['ai_refused'], ctx);
    // A refusal says nothing about why; treat it as possibly serious.
    return { status: 'review_required', moderation: 'review_required', reason: REVIEW_REASON, case: { categories, priority: Math.min(1, priorityFor(categories, ctx)) } };
  }

  const { analysis } = outcome;
  const aiCategories = [...new Set(analysis.moderation.categories)];
  const verdict = analysis.moderation.verdict;
  const severe = aiCategories.filter((c) => SEVERE_CATEGORIES.has(c));

  if (verdict === 'rejected' && severe.length > 0) {
    return {
      status: 'rejected',
      moderation: 'rejected',
      reason: 'Your video was not published because it appears to break the community rules. You can appeal this decision.',
      // Anything involving a child is always seen by a person, even when the video is already taken down.
      case: aiCategories.includes('child_safety') ? { categories: aiCategories, priority: 0 } : null,
    };
  }

  // Clearly safe, clearly football, and internally consistent: publish. Duplicates of someone else's video never are.
  if (verdict === 'safe' && analysis.footballPresent && aiCategories.length === 0 && !ctx.duplicateOfOtherOwner) {
    return { status: 'published', moderation: 'safe', reason: null, case: null };
  }

  const categories: string[] = [...aiCategories];
  if (!analysis.footballPresent && !categories.includes('non_football')) categories.push('non_football');
  // A 'rejected' verdict without a severe category is not clear-cut enough to act on alone.
  if (categories.length === 0 && verdict !== 'safe') categories.push('ai_uncertain');
  const final = withDuplicate(categories, ctx);
  return {
    status: 'review_required',
    moderation: verdict,
    reason: REVIEW_REASON,
    case: { categories: final, priority: priorityFor(final, ctx) },
  };
}
