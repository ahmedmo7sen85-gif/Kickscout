import { describe, expect, it } from 'vitest';
import {
  answerXp, canChallenge, challengeWinner, drillByKey, levelFor, streakDays, tierFor, TRAINING_DRILLS, xpForLevel,
  FAST_ANSWER_MS, XP_BEST, XP_FAST_BONUS, XP_GOOD,
} from './play.js';
import { can } from './policy.js';
import type { Actor } from './policy.js';

describe('play XP and levels', () => {
  it('scores answers: best, best and fast, reasonable, wrong', () => {
    expect(answerXp(2, FAST_ANSWER_MS + 1)).toBe(XP_BEST);
    expect(answerXp(2, 3000)).toBe(XP_BEST + XP_FAST_BONUS);
    expect(answerXp(1, 1000)).toBe(XP_GOOD);
    expect(answerXp(0, 1000)).toBe(0);
  });

  it('levels follow 50 * L * (L - 1) and cap at 50', () => {
    expect([1, 2, 3, 4, 5].map(xpForLevel)).toEqual([0, 100, 300, 600, 1000]);
    expect(levelFor(0)).toMatchObject({ level: 1, tier: 'grassroots', levelStartXp: 0, nextLevelXp: 100 });
    expect(levelFor(99).level).toBe(1);
    expect(levelFor(100).level).toBe(2);
    expect(levelFor(1000)).toMatchObject({ level: 5, tier: 'academy' });
    expect(levelFor(10_000_000)).toMatchObject({ level: 50, tier: 'legend' });
    expect(levelFor(-5).level).toBe(1);
    expect([1, 5, 10, 15, 20, 30].map(tierFor)).toEqual(['grassroots', 'academy', 'reserves', 'first_team', 'captain', 'legend']);
  });

  it('counts a streak from today, or from yesterday until today ends', () => {
    const now = new Date('2026-10-09T15:00:00Z');
    expect(streakDays(['2026-10-09', '2026-10-08', '2026-10-07', '2026-10-05'], now)).toBe(3);
    expect(streakDays(['2026-10-08', '2026-10-07'], now)).toBe(2);
    expect(streakDays(['2026-10-07'], now)).toBe(0);
    expect(streakDays([], now)).toBe(0);
  });

  it('picks the challenge winner on points, then time, else a draw', () => {
    const a = { userId: 'a', points: 8, totalMs: 30_000 };
    expect(challengeWinner(a, { userId: 'b', points: 6, totalMs: 1 })).toBe('a');
    expect(challengeWinner(a, { userId: 'b', points: 8, totalMs: 20_000 })).toBe('b');
    expect(challengeWinner(a, { userId: 'b', points: 8, totalMs: 30_000 })).toBeNull();
  });

  it('ships drills with unique keys and both languages', () => {
    expect(new Set(TRAINING_DRILLS.map((d) => d.key)).size).toBe(TRAINING_DRILLS.length);
    for (const d of TRAINING_DRILLS) {
      for (const b of [d.title, d.why, ...d.steps, ...(d.countLabel ? [d.countLabel] : [])]) {
        expect(b.en.trim()).not.toBe('');
        expect(b.ar.trim()).not.toBe('');
      }
    }
    expect(drillByKey('wall_passes')?.focus).toBe('passing');
    expect(drillByKey('nope')).toBeUndefined();
  });
});

describe('who may play a friend challenge', () => {
  const base = { mutualFollow: true, blocked: false, aBand: 'adult', bBand: 'adult', guardianPair: false } as const;

  it('needs a mutual follow and no block', () => {
    expect(canChallenge(base)).toEqual({ allowed: true });
    expect(canChallenge({ ...base, mutualFollow: false })).toMatchObject({ allowed: false, code: 'FRIENDS_ONLY' });
    expect(canChallenge({ ...base, blocked: true })).toMatchObject({ allowed: false, code: 'NOT_FOUND' });
  });

  it('keeps adults and minors apart unless the adult is the guardian', () => {
    expect(canChallenge({ ...base, bBand: 'u16' })).toMatchObject({ allowed: false, code: 'AGE_GROUP_MISMATCH' });
    expect(canChallenge({ ...base, aBand: 'u13' })).toMatchObject({ allowed: false, code: 'AGE_GROUP_MISMATCH' });
    expect(canChallenge({ ...base, bBand: 'u16', guardianPair: true })).toEqual({ allowed: true });
    expect(canChallenge({ ...base, aBand: 'u13', bBand: 'u18' })).toEqual({ allowed: true });
  });

  it('runs through the policy, which also stops inactive and unconsented accounts', () => {
    const actor: Actor = { userId: 'u', roles: ['player'], status: 'active', ageBand: 'u16', mfa: false, guardianOf: [], consents: new Set() };
    const action = { kind: 'play.challenge', opponentBand: 'adult', mutualFollow: true, blocked: false, guardianPair: false } as const;
    expect(can(actor, action)).toMatchObject({ allowed: false, code: 'AGE_GROUP_MISMATCH' });
    expect(can(actor, { ...action, opponentBand: 'u18' })).toEqual({ allowed: true });
    expect(can({ ...actor, status: 'pending_consent' }, { kind: 'play.use' })).toMatchObject({ allowed: false, code: 'CONSENT_REQUIRED' });
    expect(can(actor, { kind: 'play.use' })).toEqual({ allowed: true });
  });
});
