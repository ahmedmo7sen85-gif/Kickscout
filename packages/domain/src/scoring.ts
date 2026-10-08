/**
 * Evidence aggregation: turns observed football actions into a skill score.
 *
 * Rules that must hold (and are tested):
 * - No score without enough usable evidence: the result is `insufficient_evidence` with a reason.
 * - Excluded observations (low tracking, occlusion) and low-confidence observations never count.
 * - Popularity, followers and views are not inputs.
 * - Confidence is heuristic in Phase 1 and is reported as uncalibrated until the evaluation
 *   harness has calibrated it against coach-labeled clips.
 */

export const SCORING_METHOD_VERSION = 'skill-agg-0.1.0';

export type Outcome = 'success' | 'fail' | 'unknown';
export type Pressure = 'none' | 'low' | 'high' | 'unknown';

export interface Observation {
  id: string;
  skill: string;
  eventType: string;
  outcome: Outcome;
  tStartMs: number;
  tEndMs: number;
  /** Detector confidence for this observation, 0..1. */
  confidence: number;
  /** Readiness of the video it came from, 0..1 (from the video quality agent). */
  videoReadiness: number;
  videoId: string;
  pressure: Pressure;
  excludedReason?: string | null;
}

export interface ScoringConfig {
  minObservationConfidence: number;
  minEvidenceCount: number;
  /** Strength of the neutral prior, in pseudo-observations. Prevents extreme scores from few actions. */
  priorStrength: number;
  priorRate: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  minObservationConfidence: 0.6,
  minEvidenceCount: 5,
  priorStrength: 5,
  priorRate: 0.5,
};

/** Succeeding under pressure is stronger evidence than succeeding unopposed. */
const PRESSURE_WEIGHT: Record<Pressure, number> = { none: 0.8, low: 1, high: 1.25, unknown: 0.9 };

export type EvidenceQuality = 'low' | 'medium' | 'high';

export interface SkillExplanation {
  observedActions: number;
  successful: number;
  unsuccessful: number;
  underPressure: number;
  distinctVideos: number;
  excluded: { observationId: string; reason: string }[];
  positiveIndicators: string[];
  negativeIndicators: string[];
  limitations: string[];
}

export type SkillScore =
  | {
      skill: string;
      status: 'assessed';
      score: number;
      confidence: number;
      calibrated: false;
      evidenceCount: number;
      evidenceQuality: EvidenceQuality;
      evidence: { observationId: string; weight: number }[];
      explanation: SkillExplanation;
      methodVersion: string;
    }
  | {
      skill: string;
      status: 'insufficient_evidence';
      score: null;
      confidence: number;
      calibrated: false;
      evidenceCount: number;
      evidenceQuality: EvidenceQuality;
      evidence: { observationId: string; weight: number }[];
      explanation: SkillExplanation;
      methodVersion: string;
      reason: string;
    };

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function scoreSkill(
  skill: string,
  observations: readonly Observation[],
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): SkillScore {
  const forSkill = observations.filter((o) => o.skill === skill);
  const excluded: SkillExplanation['excluded'] = [];
  const usable: Observation[] = [];

  for (const o of forSkill) {
    if (o.excludedReason) excluded.push({ observationId: o.id, reason: o.excludedReason });
    else if (o.confidence < config.minObservationConfidence)
      excluded.push({ observationId: o.id, reason: 'low_confidence' });
    else if (o.outcome === 'unknown') excluded.push({ observationId: o.id, reason: 'outcome_not_visible' });
    else usable.push(o);
  }

  const successful = usable.filter((o) => o.outcome === 'success');
  const underPressure = usable.filter((o) => o.pressure === 'high');
  const distinctVideos = new Set(usable.map((o) => o.videoId)).size;
  const meanObsConfidence = mean(usable.map((o) => o.confidence));
  const meanReadiness = mean(usable.map((o) => o.videoReadiness));

  const limitations: string[] = [];
  if (underPressure.length === 0 && usable.length > 0) limitations.push('no_actions_under_high_pressure');
  if (distinctVideos === 1) limitations.push('single_video');
  if (excluded.length > 0) limitations.push('some_actions_excluded');
  if (meanReadiness > 0 && meanReadiness < 0.6) limitations.push('low_video_quality');

  const evidenceQuality: EvidenceQuality =
    meanObsConfidence >= 0.85 && meanReadiness >= 0.8
      ? 'high'
      : meanObsConfidence >= 0.7 && meanReadiness >= 0.6
        ? 'medium'
        : 'low';

  // Confidence grows with evidence count and is capped by observation and video quality.
  // Variety (several videos) matters: one long clip is one context.
  const countFactor = 1 - Math.exp(-usable.length / 10);
  const diversityFactor = Math.min(1, 0.7 + 0.1 * distinctVideos);
  const confidence = round(countFactor * meanObsConfidence * Math.max(meanReadiness, 0) * diversityFactor, 3);

  const positiveIndicators: string[] = [];
  const negativeIndicators: string[] = [];
  const successUnderPressure = underPressure.filter((o) => o.outcome === 'success').length;
  if (successUnderPressure > 0) positiveIndicators.push('successful_actions_under_high_pressure');
  if (usable.length > 0 && successful.length / usable.length >= 0.7) positiveIndicators.push('high_success_rate');
  if (usable.length > 0 && successful.length / usable.length < 0.4) negativeIndicators.push('low_success_rate');
  if (underPressure.length > 0 && successUnderPressure / underPressure.length < 0.4)
    negativeIndicators.push('struggles_under_high_pressure');

  const explanation: SkillExplanation = {
    observedActions: usable.length,
    successful: successful.length,
    unsuccessful: usable.length - successful.length,
    underPressure: underPressure.length,
    distinctVideos,
    excluded,
    positiveIndicators,
    negativeIndicators,
    limitations,
  };

  const weights = usable.map((o) => ({ o, w: PRESSURE_WEIGHT[o.pressure] * o.confidence }));
  const evidence = weights.map(({ o, w }) => ({ observationId: o.id, weight: round(w, 4) }));

  const base = {
    skill,
    calibrated: false as const,
    evidenceCount: usable.length,
    evidenceQuality,
    evidence,
    explanation,
    methodVersion: SCORING_METHOD_VERSION,
  };

  if (usable.length < config.minEvidenceCount) {
    return {
      ...base,
      status: 'insufficient_evidence',
      score: null,
      confidence,
      reason: `needs at least ${config.minEvidenceCount} usable actions, found ${usable.length}`,
    };
  }

  // Weighted success rate, shrunk toward a neutral prior so a handful of actions cannot produce 100.
  const weightedSuccess = weights.reduce((acc, { o, w }) => acc + (o.outcome === 'success' ? w : 0), 0);
  const totalWeight = weights.reduce((acc, { w }) => acc + w, 0);
  const rate =
    (config.priorStrength * config.priorRate + weightedSuccess) / (config.priorStrength + totalWeight);
  const score = round(Math.min(100, Math.max(0, rate * 100)), 1);

  return { ...base, status: 'assessed', score, confidence };
}
