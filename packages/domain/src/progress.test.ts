import { describe, expect, it } from 'vitest';
import { compareMeasurements } from './progress.js';

describe('progress', () => {
  it('says there is not enough new evidence when little was added', () => {
    const r = compareMeasurements({ score: 70, confidence: 0.8, evidenceCount: 20 }, { score: 80, confidence: 0.8, evidenceCount: 22 });
    expect(r.verdict).toBe('insufficient_evidence');
    if (r.verdict === 'insufficient_evidence') expect(r.message.en).toBe('Not enough new evidence to determine improvement.');
  });

  it('does not call a change inside the uncertainty an improvement', () => {
    const r = compareMeasurements({ score: 70, confidence: 0.7, evidenceCount: 10 }, { score: 74, confidence: 0.7, evidenceCount: 20 });
    expect(r.verdict).toBe('no_meaningful_change');
  });

  it('reports a clear improvement backed by plenty of evidence', () => {
    const r = compareMeasurements({ score: 60, confidence: 0.9, evidenceCount: 100 }, { score: 75, confidence: 0.9, evidenceCount: 200 });
    expect(r.verdict).toBe('improved');
  });
});
