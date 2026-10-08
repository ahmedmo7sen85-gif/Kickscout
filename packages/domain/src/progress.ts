/**
 * Development tracking. A change counts only when it is larger than the uncertainty of both
 * measurements; otherwise the honest answer is that there is not enough new evidence.
 */

export interface Measurement {
  score: number | null;
  confidence: number;
  evidenceCount: number;
}

export type ProgressVerdict =
  | { verdict: 'improved' | 'declined' | 'no_meaningful_change'; delta: number; margin: number }
  | { verdict: 'insufficient_evidence'; message: { en: string; ar: string } };

const INSUFFICIENT = {
  en: 'Not enough new evidence to determine improvement.',
  ar: 'لا توجد أدلة جديدة كافية لتحديد التحسن.',
};

/** Uncertainty in score points: wide when confidence or evidence is low. */
export function uncertaintyMargin(m: Measurement): number {
  const fromConfidence = (1 - m.confidence) * 20;
  const fromCount = 30 / Math.sqrt(Math.max(m.evidenceCount, 1));
  return Math.round(Math.max(fromConfidence, fromCount) * 10) / 10;
}

export function compareMeasurements(before: Measurement, after: Measurement, minNewEvidence = 5): ProgressVerdict {
  if (before.score === null || after.score === null || after.evidenceCount - before.evidenceCount < minNewEvidence) {
    return { verdict: 'insufficient_evidence', message: INSUFFICIENT };
  }
  const delta = Math.round((after.score - before.score) * 10) / 10;
  const margin = Math.round(Math.hypot(uncertaintyMargin(before), uncertaintyMargin(after)) * 10) / 10;
  if (Math.abs(delta) <= margin) return { verdict: 'no_meaningful_change', delta, margin };
  return { verdict: delta > 0 ? 'improved' : 'declined', delta, margin };
}
