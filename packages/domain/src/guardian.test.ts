import { describe, expect, it } from 'vitest';
import { DEFAULT_GUARDIAN_POLICY, enforcementFor, mergePolicy, thresholdsFor, worstSeverity } from './guardian.js';
import type { Severity } from './guardian.js';

const strikes = (...s: Severity[]) => s.map((severity) => ({ severity, createdAt: new Date() }));

describe('Guardian policy', () => {
  it('uses severity thresholds unless a category overrides them', () => {
    expect(thresholdsFor(DEFAULT_GUARDIAN_POLICY, 'nudity')).toEqual({ review: 0.3, reject: 0.85 });
    expect(thresholdsFor(DEFAULT_GUARDIAN_POLICY, 'spam')).toEqual({ review: 0.6, reject: null });
    const p = mergePolicy(DEFAULT_GUARDIAN_POLICY, { categories: { spam: { review: 0.8 } } });
    expect(thresholdsFor(p, 'spam')).toEqual({ review: 0.8, reject: null });
  });

  it('merges an override deeply and ignores unknown keys and wrong types', () => {
    const p = mergePolicy(DEFAULT_GUARDIAN_POLICY, {
      version: '2026-11-01', minConfidence: 0.7, sampling: { maxFrames: 48, bogus: 1 }, football: { approveMin: 'high' },
      severity: { serious: { reject: null } }, categories: { not_a_category: { review: 0 } }, deepPass: 'on_risk', dailyBudgetUsd: 5,
    });
    expect(p.version).toBe('2026-11-01');
    expect(p.minConfidence).toBe(0.7);
    expect(p.sampling.maxFrames).toBe(48);
    expect(p.sampling.intervalMs).toBe(DEFAULT_GUARDIAN_POLICY.sampling.intervalMs);
    expect('bogus' in p.sampling).toBe(false);
    expect(p.football.approveMin).toBe(0.7);
    expect(p.severity.serious).toEqual({ review: 0.3, reject: null });
    expect(p.categories).toEqual({});
    expect(p.deepPass).toBe('on_risk');
    expect(p.dailyBudgetUsd).toBe(5);
    expect(DEFAULT_GUARDIAN_POLICY.severity.serious.reject).toBe(0.85); // the default is untouched
    expect(mergePolicy(DEFAULT_GUARDIAN_POLICY, null)).toBe(DEFAULT_GUARDIAN_POLICY);
  });
});

describe('enforcement ladder', () => {
  it('escalates serious violations and suspends on any critical one; a paid plan is not an input', () => {
    expect(enforcementFor([])).toEqual({ action: 'none' });
    expect(enforcementFor(strikes('serious'))).toEqual({ action: 'restrict_uploads', days: 7 });
    expect(enforcementFor(strikes('serious', 'serious'))).toEqual({ action: 'restrict_uploads', days: 30 });
    expect(enforcementFor(strikes('serious', 'serious', 'serious'))).toEqual({ action: 'suspend' });
    expect(enforcementFor(strikes('critical'))).toEqual({ action: 'suspend' });
  });

  it('adds up lesser violations more slowly', () => {
    expect(enforcementFor(strikes('minor', 'minor'))).toEqual({ action: 'none' });
    expect(enforcementFor(strikes('moderate', 'moderate'))).toEqual({ action: 'none' });
    expect(enforcementFor(strikes('moderate', 'moderate', 'moderate'))).toEqual({ action: 'restrict_uploads', days: 1 });
    expect(enforcementFor(strikes('moderate', 'moderate', 'moderate', 'moderate'))).toEqual({ action: 'restrict_uploads', days: 7 });
    expect(enforcementFor(strikes(...Array<Severity>(8).fill('moderate')))).toEqual({ action: 'suspend' });
  });

  it('finds the most severe category', () => {
    expect(worstSeverity(['spam', 'nudity', 'suggestive'])).toBe('serious');
    expect(worstSeverity(['not_football'])).toBeNull();
  });
});
