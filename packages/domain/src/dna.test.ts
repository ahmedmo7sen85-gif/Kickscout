import { describe, expect, it } from 'vitest';
import { buildPlayerDna } from './dna.js';
import { computeIndex, computePositionIndex } from './frameworks.js';

const skill = (s: string, score: number | null, confidence = 0.8) => ({ skill: s, score, confidence, evidenceCount: 10 });

describe('indexes and Player DNA', () => {
  it('does not compute an index from a single skill', () => {
    expect(computeIndex('technical', [skill('dribbling', 80)]).score).toBeNull();
  });

  it('computes the technical index from covered skills only', () => {
    const ix = computeIndex('technical', [skill('dribbling', 80), skill('passing', 60), skill('shooting', 70), skill('ball_control', 75)]);
    expect(ix.score).toBe(71.3);
    expect(ix.coverage).toBeGreaterThanOrEqual(0.5);
  });

  it('withholds a position index when the position is mostly unassessed', () => {
    const tech = computeIndex('technical', [skill('dribbling', 80), skill('passing', 60), skill('shooting', 70), skill('ball_control', 75)]);
    // a winger is 40% technical; the other 60% has no evidence yet
    expect(computePositionIndex('RW', [tech]).score).toBeNull();
  });

  it('labels user-provided facts and lists what was not assessed', () => {
    const dna = buildPlayerDna(
      { primaryPosition: 'RW', secondaryPositions: ['LW'], preferredFoot: 'left' },
      [skill('dribbling', 85), skill('passing', 62), skill('shooting', 74), skill('ball_control', 80), skill('first_touch', null)],
    );
    expect(dna.position.source).toBe('user_provided');
    expect(dna.preferredFoot.source).toBe('user_provided');
    expect(dna.notAssessed).toEqual(['first_touch']);
    expect(dna.strengths[0]?.skill).toBe('dribbling');
    expect(dna.developmentAreas[0]?.skill).toBe('passing');
    expect(dna.nature).toBe('probabilistic_evidence_based');
    expect(dna.disclaimer.en).toMatch(/not a definitive measure/);
  });

  it('names no strengths or weaknesses without enough confident skills', () => {
    const dna = buildPlayerDna({ primaryPosition: null, secondaryPositions: [], preferredFoot: null }, [skill('dribbling', 90)]);
    expect(dna.strengths).toEqual([]);
    expect(dna.developmentAreas).toEqual([]);
    expect(dna.positionIndex).toBeNull();
  });
});
