/**
 * Player DNA: a versioned, evidence-based profile. Every field records where it came from:
 * the player (user-provided), or aggregated observations (evidence).
 */
import { computeIndex, computePositionIndex, INDEXES, OVERALL_SCORE_DISCLAIMER, FRAMEWORK_VERSION } from './frameworks.js';
import type { IndexScore, Position, ScoredSkill } from './frameworks.js';

export const DNA_METHOD_VERSION = 'dna-0.1.0';
const STRENGTH_MIN_CONFIDENCE = 0.5;

export interface PlayerFacts {
  primaryPosition: Position | null;
  secondaryPositions: Position[];
  preferredFoot: 'left' | 'right' | 'both' | null;
}

export interface PlayerDna {
  methodVersion: string;
  frameworkVersion: string;
  position: { primary: Position | null; secondary: Position[]; source: 'user_provided' };
  preferredFoot: { value: PlayerFacts['preferredFoot']; source: 'user_provided' };
  indexes: IndexScore[];
  positionIndex: ReturnType<typeof computePositionIndex> | null;
  strengths: { skill: string; score: number; confidence: number }[];
  developmentAreas: { skill: string; score: number; confidence: number }[];
  notAssessed: string[];
  overallConfidence: number;
  disclaimer: typeof OVERALL_SCORE_DISCLAIMER;
  nature: 'probabilistic_evidence_based';
}

export function buildPlayerDna(facts: PlayerFacts, skills: readonly ScoredSkill[]): PlayerDna {
  const indexes = INDEXES.map((ix) => computeIndex(ix, skills));
  const assessed = skills.filter(
    (s): s is ScoredSkill & { score: number } => s.score !== null && s.confidence >= STRENGTH_MIN_CONFIDENCE,
  );
  const sorted = [...assessed].sort((a, b) => b.score - a.score);
  const pick = (s: ScoredSkill & { score: number }) => ({ skill: s.skill, score: s.score, confidence: s.confidence });

  // With fewer than two confident skills, ranking strengths against weaknesses means nothing.
  const strengths = sorted.length >= 2 ? sorted.slice(0, Math.min(3, Math.floor(sorted.length / 2))).map(pick) : [];
  const developmentAreas =
    sorted.length >= 2 ? sorted.slice(-Math.min(3, Math.floor(sorted.length / 2))).reverse().map(pick) : [];

  const scoredIndexes = indexes.filter((i) => i.score !== null);
  const overallConfidence =
    scoredIndexes.length === 0
      ? 0
      : Math.round((scoredIndexes.reduce((a, i) => a + i.confidence, 0) / scoredIndexes.length) * 1000) / 1000;

  return {
    methodVersion: DNA_METHOD_VERSION,
    frameworkVersion: FRAMEWORK_VERSION,
    position: { primary: facts.primaryPosition, secondary: facts.secondaryPositions, source: 'user_provided' },
    preferredFoot: { value: facts.preferredFoot, source: 'user_provided' },
    indexes,
    positionIndex: facts.primaryPosition ? computePositionIndex(facts.primaryPosition, indexes) : null,
    strengths,
    developmentAreas,
    notAssessed: skills.filter((s) => s.score === null).map((s) => s.skill),
    overallConfidence,
    disclaimer: OVERALL_SCORE_DISCLAIMER,
    nature: 'probabilistic_evidence_based',
  };
}
