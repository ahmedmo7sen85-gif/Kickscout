import { describe, expect, it } from 'vitest';
import { scoreSkill } from './scoring.js';
import type { Observation } from './scoring.js';

let n = 0;
const obs = (over: Partial<Observation> = {}): Observation => ({
  id: `o${++n}`,
  skill: 'dribbling',
  eventType: 'dribble_attempt',
  outcome: 'success',
  tStartMs: 0,
  tEndMs: 1000,
  confidence: 0.9,
  videoReadiness: 0.9,
  videoId: 'v1',
  pressure: 'low',
  ...over,
});

describe('scoreSkill', () => {
  it('returns insufficient evidence instead of a number when there are too few actions', () => {
    const r = scoreSkill('dribbling', [obs(), obs(), obs()]);
    expect(r.status).toBe('insufficient_evidence');
    expect(r.score).toBeNull();
    expect(r.evidenceCount).toBe(3);
  });

  it('never counts excluded, low-confidence or unseen-outcome actions', () => {
    const r = scoreSkill('dribbling', [
      ...Array.from({ length: 4 }, () => obs()),
      obs({ excludedReason: 'low_tracking' }),
      obs({ confidence: 0.3 }),
      obs({ outcome: 'unknown' }),
    ]);
    expect(r.status).toBe('insufficient_evidence');
    expect(r.explanation.excluded.map((e) => e.reason).sort()).toEqual(['low_confidence', 'low_tracking', 'outcome_not_visible']);
    expect(r.explanation.limitations).toContain('some_actions_excluded');
  });

  it('shrinks toward neutral so a perfect small sample does not score 100', () => {
    const r = scoreSkill('dribbling', Array.from({ length: 5 }, () => obs()));
    expect(r.status).toBe('assessed');
    expect(r.score).toBeLessThan(80);
    expect(r.score).toBeGreaterThan(50);
  });

  it('scores higher with more consistent success and lower with failures', () => {
    const good = scoreSkill('dribbling', Array.from({ length: 20 }, () => obs()));
    const mixed = scoreSkill('dribbling', Array.from({ length: 20 }, (_, i) => obs({ outcome: i % 2 ? 'success' : 'fail' })));
    expect(good.score!).toBeGreaterThan(mixed.score!);
    expect(mixed.explanation.positiveIndicators).not.toContain('high_success_rate');
  });

  it('gives more confidence to more evidence across more videos, and says it is uncalibrated', () => {
    const one = scoreSkill('dribbling', Array.from({ length: 6 }, () => obs()));
    const many = scoreSkill('dribbling', Array.from({ length: 24 }, (_, i) => obs({ videoId: `v${i % 4}` })));
    expect(many.confidence).toBeGreaterThan(one.confidence);
    expect(one.explanation.limitations).toContain('single_video');
    expect(one.calibrated).toBe(false);
  });

  it('flags missing high-pressure evidence as a limitation', () => {
    const r = scoreSkill('dribbling', Array.from({ length: 8 }, () => obs({ pressure: 'none' })));
    expect(r.explanation.limitations).toContain('no_actions_under_high_pressure');
  });

  it('links every counted action as evidence', () => {
    const list = Array.from({ length: 6 }, () => obs());
    const r = scoreSkill('dribbling', list);
    expect(r.evidence.map((e) => e.observationId)).toEqual(list.map((o) => o.id));
  });

  it('ignores observations for other skills', () => {
    const r = scoreSkill('passing', Array.from({ length: 10 }, () => obs()));
    expect(r.evidenceCount).toBe(0);
    expect(r.confidence).toBe(0);
  });
});
