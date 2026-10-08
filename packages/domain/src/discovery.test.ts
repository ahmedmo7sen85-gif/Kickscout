import { describe, expect, it } from 'vitest';
import { discoveryScore, popularityScore } from './discovery.js';

describe('discovery vs popularity', () => {
  const strong = { performance: 85, confidence: 0.8, trend: 4, videoQuality: 0.9 };

  it('lets a strong player with no audience outrank a weak player with a huge audience', () => {
    const hidden = discoveryScore({ ...strong, engagement: 0 })!;
    const famous = discoveryScore({ performance: 50, confidence: 0.8, trend: 0, videoQuality: 0.9, engagement: 1 })!;
    expect(hidden).toBeGreaterThan(famous);
  });

  it('keeps engagement to a small share of discovery', () => {
    const a = discoveryScore({ ...strong, engagement: 0 })!;
    const b = discoveryScore({ ...strong, engagement: 1 })!;
    expect(b - a).toBeLessThanOrEqual(10);
  });

  it('has no discovery score without assessed performance', () => {
    expect(discoveryScore({ performance: null, confidence: 0.9, trend: null, videoQuality: 1, engagement: 1 })).toBeNull();
  });

  it('computes popularity separately', () => {
    expect(popularityScore(100, 1000)).toBeLessThan(popularityScore(1_000_000, 10_000_000));
  });
});
