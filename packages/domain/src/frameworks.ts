/**
 * Position-specific evaluation frameworks. There is no universal score: each position weights the
 * indexes differently, and each index is built only from the skills that belong to it.
 */

export const POSITIONS = ['GK', 'CB', 'LB', 'RB', 'DM', 'CM', 'AM', 'LW', 'RW', 'ST'] as const;
export type Position = (typeof POSITIONS)[number];

export const INDEXES = ['technical', 'tactical', 'movement', 'decision', 'defensive', 'goalkeeping'] as const;
export type IndexName = (typeof INDEXES)[number];

export const FRAMEWORK_VERSION = 'frameworks-0.1.0';

/** Which skills make up each index, with relative weights inside the index. */
export const INDEX_SKILLS: Record<IndexName, Record<string, number>> = {
  technical: { ball_control: 1, first_touch: 1, dribbling: 1, passing: 1, shooting: 1, crossing: 0.7, weak_foot: 0.6 },
  tactical: { positioning: 1, off_ball_movement: 1, spacing: 0.8, pressing: 0.8, transition: 0.8 },
  movement: { acceleration: 1, agility: 1, balance: 0.8, coordination: 0.8 },
  decision: { pass_or_dribble: 1, shot_selection: 1, pressure_response: 1, risk_management: 0.8 },
  defensive: { tackling: 1, interceptions: 1, defensive_positioning: 1, aerial: 0.7 },
  goalkeeping: { gk_positioning: 1, handling: 1, reflexes: 1, distribution: 0.8, cross_management: 0.8, gk_1v1: 0.8 },
};

/** How much each index counts for a position. Missing index = weight 0. */
export const POSITION_WEIGHTS: Record<Position, Partial<Record<IndexName, number>>> = {
  GK: { goalkeeping: 0.6, decision: 0.2, technical: 0.1, tactical: 0.1 },
  CB: { defensive: 0.4, tactical: 0.25, technical: 0.15, movement: 0.1, decision: 0.1 },
  LB: { defensive: 0.3, movement: 0.2, technical: 0.2, tactical: 0.2, decision: 0.1 },
  RB: { defensive: 0.3, movement: 0.2, technical: 0.2, tactical: 0.2, decision: 0.1 },
  DM: { defensive: 0.3, tactical: 0.3, technical: 0.2, decision: 0.2 },
  CM: { technical: 0.3, tactical: 0.25, decision: 0.25, defensive: 0.1, movement: 0.1 },
  AM: { technical: 0.4, decision: 0.3, tactical: 0.2, movement: 0.1 },
  LW: { technical: 0.4, movement: 0.25, decision: 0.2, tactical: 0.15 },
  RW: { technical: 0.4, movement: 0.25, decision: 0.2, tactical: 0.15 },
  ST: { technical: 0.4, movement: 0.2, decision: 0.25, tactical: 0.15 },
};

export interface ScoredSkill {
  skill: string;
  score: number | null;
  confidence: number;
  evidenceCount: number;
}

export interface IndexScore {
  index: IndexName;
  score: number | null;
  confidence: number;
  /** Share of the index's skill weight that had a score. */
  coverage: number;
  skillsUsed: string[];
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/** An index needs at least half of its weight covered and two assessed skills. */
export function computeIndex(index: IndexName, skills: readonly ScoredSkill[]): IndexScore {
  const weights = INDEX_SKILLS[index];
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  let covered = 0;
  let weighted = 0;
  let confWeighted = 0;
  const used: string[] = [];
  for (const s of skills) {
    const w = weights[s.skill];
    if (w === undefined || s.score === null) continue;
    covered += w;
    weighted += w * s.score;
    confWeighted += w * s.confidence;
    used.push(s.skill);
  }
  const coverage = round(covered / totalWeight, 3);
  if (used.length < 2 || coverage < 0.5) {
    return { index, score: null, confidence: covered === 0 ? 0 : round((confWeighted / covered) * coverage, 3), coverage, skillsUsed: used };
  }
  return {
    index,
    score: round(weighted / covered, 1),
    // Partial coverage lowers confidence in the index as a whole.
    confidence: round((confWeighted / covered) * coverage, 3),
    coverage,
    skillsUsed: used,
  };
}

/** Position-specific index: needs at least 60% of the position's weight to be assessed. */
export function computePositionIndex(
  position: Position,
  indexes: readonly IndexScore[],
): { position: Position; score: number | null; confidence: number; coverage: number } {
  const weights = POSITION_WEIGHTS[position];
  let covered = 0;
  let weighted = 0;
  let confWeighted = 0;
  for (const ix of indexes) {
    const w = weights[ix.index];
    if (!w || ix.score === null) continue;
    covered += w;
    weighted += w * ix.score;
    confWeighted += w * ix.confidence;
  }
  if (covered < 0.6) return { position, score: null, confidence: 0, coverage: round(covered, 3) };
  return {
    position,
    score: round(weighted / covered, 1),
    // Position weights sum to 1, so this is mean index confidence scaled by coverage.
    confidence: round(confWeighted, 3),
    coverage: round(covered, 3),
  };
}

export const OVERALL_SCORE_DISCLAIMER = {
  en: 'The overall score reflects currently available evidence and is not a definitive measure of football ability.',
  ar: 'تعكس النتيجة الإجمالية الأدلة المتاحة حاليًا، وليست مقياسًا نهائيًا للقدرة الكروية.',
};
