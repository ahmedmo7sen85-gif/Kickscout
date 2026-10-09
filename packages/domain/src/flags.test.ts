import { describe, expect, it } from 'vitest';
import { evaluateFlag, flagBucket, fnv1a32, matchesAudience } from './flags.js';
import type { FlagDefinition, FlagSubject } from './flags.js';

const flag = (over: Partial<FlagDefinition> = {}): FlagDefinition => ({ key: 'nl_scout_search', enabled: true, rolloutPercentage: 100, audience: {}, ...over });
const subject = (over: Partial<FlagSubject> = {}): FlagSubject => ({ key: '0192e000-0000-7000-8000-000000000001', roles: ['fan'], country: 'EG', ...over });
const ids = Array.from({ length: 2000 }, (_, i) => `0192e000-0000-7000-8000-${String(i).padStart(12, '0')}`);

describe('feature flag bucketing', () => {
  it('is deterministic and matches the reference FNV-1a values', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    for (const id of ids.slice(0, 50)) expect(flagBucket('hls_streaming', id)).toBe(flagBucket('hls_streaming', id));
  });

  it('spreads subjects roughly evenly and independently per flag', () => {
    const on = ids.filter((id) => evaluateFlag(flag({ rolloutPercentage: 25 }), subject({ key: id }))).length;
    expect(on / ids.length).toBeGreaterThan(0.2);
    expect(on / ids.length).toBeLessThan(0.3);
    const a = ids.map((id) => flagBucket('flag_a', id));
    const b = ids.map((id) => flagBucket('flag_b', id));
    expect(a.filter((x, i) => x === b[i]).length).toBeLessThan(ids.length * 0.05);
  });

  it('only grows the set of subjects as the rollout grows', () => {
    const at = (pct: number) => new Set(ids.filter((id) => evaluateFlag(flag({ rolloutPercentage: pct }), subject({ key: id }))));
    const ten = at(10);
    const fifty = at(50);
    for (const id of ten) expect(fifty.has(id)).toBe(true);
    expect(at(0).size).toBe(0);
    expect(at(100).size).toBe(ids.length);
  });

  it('is off when disabled, whatever the rollout', () => {
    expect(evaluateFlag(flag({ enabled: false }), subject())).toBe(false);
  });

  it('gives signed-out callers without a key only fully rolled-out flags', () => {
    expect(evaluateFlag(flag({ rolloutPercentage: 100 }), subject({ key: null }))).toBe(true);
    expect(evaluateFlag(flag({ rolloutPercentage: 99 }), subject({ key: null }))).toBe(false);
  });
});

describe('feature flag audience rules', () => {
  it('matches roles (any of) and countries (any of)', () => {
    expect(matchesAudience({ roles: ['scout'] }, subject({ roles: ['fan'] }))).toBe(false);
    expect(matchesAudience({ roles: ['scout', 'admin'] }, subject({ roles: ['fan', 'scout'] }))).toBe(true);
    expect(matchesAudience({ countries: ['MA', 'EG'] }, subject({ country: 'EG' }))).toBe(true);
    expect(matchesAudience({ countries: ['MA'] }, subject({ country: 'EG' }))).toBe(false);
    expect(matchesAudience({ countries: ['MA'] }, subject({ country: null }))).toBe(false);
    expect(matchesAudience({}, subject())).toBe(true);
  });

  it('requires every rule present to match', () => {
    const f = flag({ audience: { roles: ['scout'], countries: ['EG'] } });
    expect(evaluateFlag(f, subject({ roles: ['scout'], country: 'EG' }))).toBe(true);
    expect(evaluateFlag(f, subject({ roles: ['scout'], country: 'MA' }))).toBe(false);
    expect(evaluateFlag(f, subject({ roles: ['player'], country: 'EG' }))).toBe(false);
  });
});
