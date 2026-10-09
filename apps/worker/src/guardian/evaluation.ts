/**
 * Quality measurement for the Guardian. Each evaluated clip has a ground-truth label (from a licensed
 * or synthetic test set, never illegal material) and the decision the Guardian made. "Positive" means
 * the clip should not be published (prohibited content, or not football).
 */

export type TruthLabel = 'allowed' | 'prohibited' | 'not_football';

export interface EvaluatedClip {
  id: string;
  truth: TruthLabel;
  /** Free-form slice tags for fairness checks: lighting, camera, skin tone, kit, gender, setting... */
  slices?: string[];
  decision: 'APPROVED' | 'REJECTED' | 'HUMAN_REVIEW' | 'SCAN_FAILED';
  /** The decision a human reviewer took when the Guardian sent the clip to review, if known. */
  reviewOutcome?: 'approved' | 'rejected';
  latencyMs?: number;
  costUsd?: number;
  /** The Guardian's football call: relevance at or above the approval threshold. */
  predictedFootball?: boolean;
}

export interface GuardianMetrics {
  clips: number;
  /** Of the clips blocked automatically, the share that should have been blocked. */
  precision: number | null;
  /** Of the clips that should not be published, the share kept from publication (blocked or held for review). */
  recall: number | null;
  /** Allowed clips wrongly rejected outright. */
  falsePositiveRate: number | null;
  /** Clips that should not be published but were approved automatically. The number that must stay near zero. */
  falseNegativeRate: number | null;
  footballAccuracy: number | null;
  humanReviewRate: number | null;
  scanFailureRate: number | null;
  averageLatencyMs: number | null;
  averageCostUsd: number | null;
}

const ratio = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 10_000) / 10_000);
const avg = (xs: number[]) => (xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10_000) / 10_000);

export function guardianMetrics(clips: readonly EvaluatedClip[]): GuardianMetrics {
  const bad = clips.filter((c) => c.truth !== 'allowed');
  const good = clips.filter((c) => c.truth === 'allowed');
  const rejected = clips.filter((c) => c.decision === 'REJECTED');
  const football = clips.filter((c) => c.predictedFootball !== undefined);
  return {
    clips: clips.length,
    precision: ratio(rejected.filter((c) => c.truth !== 'allowed').length, rejected.length),
    recall: ratio(bad.filter((c) => c.decision !== 'APPROVED').length, bad.length),
    falsePositiveRate: ratio(good.filter((c) => c.decision === 'REJECTED').length, good.length),
    falseNegativeRate: ratio(bad.filter((c) => c.decision === 'APPROVED').length, bad.length),
    footballAccuracy: ratio(football.filter((c) => c.predictedFootball === (c.truth !== 'not_football')).length, football.length),
    humanReviewRate: ratio(clips.filter((c) => c.decision === 'HUMAN_REVIEW').length, clips.length),
    scanFailureRate: ratio(clips.filter((c) => c.decision === 'SCAN_FAILED').length, clips.length),
    averageLatencyMs: avg(clips.flatMap((c) => (c.latencyMs === undefined ? [] : [c.latencyMs]))),
    averageCostUsd: avg(clips.flatMap((c) => (c.costUsd === undefined ? [] : [c.costUsd]))),
  };
}

/** The same metrics per slice, to spot a slice (dark pitches, a skin tone, a kind of kit) that is blocked or missed more often. */
export function metricsBySlice(clips: readonly EvaluatedClip[]): Record<string, GuardianMetrics> {
  const slices = new Set(clips.flatMap((c) => c.slices ?? []));
  return Object.fromEntries([...slices].sort().map((s) => [s, guardianMetrics(clips.filter((c) => c.slices?.includes(s)))]));
}

/** Share of decided appeals that overturned the original decision. */
export function appealReversalRate(appeals: readonly { status: 'pending' | 'upheld' | 'overturned' }[]): number | null {
  const decided = appeals.filter((a) => a.status !== 'pending');
  return ratio(decided.filter((a) => a.status === 'overturned').length, decided.length);
}
