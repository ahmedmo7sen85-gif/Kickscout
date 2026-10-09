import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_TEMPLATES, adminTransition, challengeIndexable, challengePhase, checkEligibility, compareEntries, computeScore, consolidate,
  countsAsAttempt, detectVoteBursts, headToHeadWinner, isoWeekKey, noticeAllowed, rankEntries, recommendChallenges, rubricProblems,
  scheduledTransition, scoringRoute, seoDescription, stateFromVideo, verifySubmission, voteDecision, weeklyStreak, ScoreInputError,
} from './index.js';
import type { EligibilityInput, RankableEntry, Rubric } from './index.js';

const tpl = (slug: string) => CHALLENGE_TEMPLATES.find((t) => t.slug === slug)!.rubric;
const juggling = tpl('tpl-juggling-king');
const cones = tpl('tpl-cone-master');
const target = tpl('tpl-target-shot');
const combo = tpl('tpl-three-move-combo');
const trick = tpl('tpl-trick-of-the-week');

describe('challenge catalog', () => {
  it('has the twelve templates with unique slugs, keys and valid rubrics', () => {
    expect(CHALLENGE_TEMPLATES).toHaveLength(12);
    expect(new Set(CHALLENGE_TEMPLATES.map((t) => t.slug)).size).toBe(12);
    expect(new Set(CHALLENGE_TEMPLATES.map((t) => t.templateKey)).size).toBe(12);
    for (const t of CHALLENGE_TEMPLATES) {
      expect(rubricProblems(t.rubric), t.slug).toEqual([]);
      expect(t.slug).toMatch(/^[a-z0-9-]{3,60}$/);
      expect(t.minDurationS).toBeLessThanOrEqual(t.maxDurationS);
      expect(t.maxDurationS).toBeLessThanOrEqual(60);
      expect(t.title.ar.length && t.description.ar.length && t.instructions.ar.length).toBeTruthy();
    }
  });

  it('asks for safety notes on every advanced and expert template', () => {
    for (const t of CHALLENGE_TEMPLATES.filter((x) => x.difficulty === 'advanced' || x.difficulty === 'expert')) expect(t.safetyNotes, t.slug).not.toBeNull();
  });

  it('never mentions cash, betting or entry fees', () => {
    const text = JSON.stringify(CHALLENGE_TEMPLATES).toLowerCase();
    for (const word of ['cash', 'bet ', 'betting', 'entry fee', 'odds', 'prize money', 'rooftop', 'traffic jam']) expect(text).not.toContain(word);
  });
});

describe('rubric scoring', () => {
  it('measures a count and refuses fractional or out-of-range touches', () => {
    expect(computeScore(juggling, { touches: 87 }).value).toBe(87);
    expect(() => computeScore(juggling, { touches: 8.5 })).toThrow(ScoreInputError);
    expect(() => computeScore(juggling, { touches: 601 })).toThrow(ScoreInputError);
    expect(() => computeScore(juggling, {})).toThrow(/required/);
    expect(() => computeScore(juggling, { touches: 3, bonus: 1 })).toThrow(/unknown/);
  });

  it('adds penalties to a time and lower is better', () => {
    const s = computeScore(cones, { time_ms: 14250, missed_cones: 2 });
    expect(s).toMatchObject({ value: 18250, penalties: 4000 });
  });

  it('caps hits at the fixed number of attempts', () => {
    expect(computeScore(target, { hits: 7 }).value).toBe(7);
    expect(() => computeScore(target, { hits: 11 })).toThrow();
  });

  it('weights judged criteria to a value out of 100', () => {
    expect(computeScore(combo, { valid_moves: 3, flow: 10, execution: 10 }).value).toBe(100);
    expect(computeScore(combo, { valid_moves: 2, flow: 5, execution: 8 }).value).toBe(65.7);
  });

  it('flags rubric mistakes', () => {
    const bad: Rubric = { ...combo, components: combo.components.map((c) => ({ ...c, weight: 0.5 })) };
    expect(rubricProblems(bad)).toContain('criterion weights must add up to 1');
    expect(rubricProblems({ ...target, attempts: null })).toContain('a hits rubric needs a fixed number of attempts');
    expect(rubricProblems({ ...juggling, components: [] })).toContain('a measured rubric needs exactly one measure component');
  });
});

describe('consolidation and ranking', () => {
  it('waits for the judges the rubric needs', () => {
    expect(consolidate(trick, [computeScore(trick, { execution: 8, difficulty: 9, landing: 7 })])).toEqual({ status: 'need_more', have: 1, need: 2 });
  });

  it('sends disagreement beyond tolerance to an admin instead of averaging', () => {
    const a = computeScore(trick, { execution: 10, difficulty: 10, landing: 10 });
    const b = computeScore(trick, { execution: 2, difficulty: 3, landing: 2 });
    expect(consolidate(trick, [a, b]).status).toBe('disagree');
  });

  it('averages agreeing judges, and keeps the conservative measured value', () => {
    const a = computeScore(trick, { execution: 8, difficulty: 8, landing: 8 });
    const b = computeScore(trick, { execution: 9, difficulty: 8, landing: 8 });
    const c = consolidate(trick, [a, b]);
    expect(c.status === 'agreed' && c.result.value).toBe(82.5);
    const two = { ...juggling, minJudges: 2 as const };
    const m = consolidate(two, [computeScore(two, { touches: 101 }), computeScore(two, { touches: 100 })]);
    expect(m.status === 'agreed' && m.result.value).toBe(100);
  });

  const e = (id: string, userId: string, value: number, penalties = 0, at = '2026-10-01T10:00:00Z'): RankableEntry => ({ submissionId: id, userId, value, penalties, components: {}, submittedAt: at });

  it('ranks best entry per player, with tie-breakers and shared ranks', () => {
    const ranked = rankEntries(cones, [
      e('a1', 'A', 15000, 2000), e('a2', 'A', 12000), e('b1', 'B', 12000, 0, '2026-10-01T09:00:00Z'), e('c1', 'C', 12000, 2000), e('d1', 'D', 20000),
    ]);
    expect(ranked.map((r) => [r.userId, r.rank])).toEqual([['B', 1], ['A', 2], ['C', 3], ['D', 4]]);
    const tied = rankEntries({ ...juggling, tieBreakers: [] }, [e('x', 'X', 50), e('y', 'Y', 50), e('z', 'Z', 40)]);
    expect(tied.map((r) => r.rank)).toEqual([1, 1, 3]);
  });

  it('orders higher-is-better and lower-is-better correctly', () => {
    expect(compareEntries(juggling, e('a', 'A', 10), e('b', 'B', 20))).toBeGreaterThan(0);
    expect(compareEntries(cones, e('a', 'A', 10), e('b', 'B', 20))).toBeLessThan(0);
  });
});

describe('AI scoring gate', () => {
  it('routes every template to human judging (no validated measurement model)', () => {
    for (const t of CHALLENGE_TEMPLATES) expect(scoringRoute(t.rubric).route).toBe('human');
  });
});

describe('lifecycle', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const t = (status: string, s: string, e: string) => ({ status: status as never, startsAt: new Date(s), endsAt: new Date(e) });

  it('derives the phase from status and dates', () => {
    expect(challengePhase(t('active', '2026-10-01', '2026-10-20'), now)).toBe('open');
    expect(challengePhase(t('scheduled', '2026-10-11', '2026-10-20'), now)).toBe('upcoming');
    expect(challengePhase(t('active', '2026-10-01', '2026-10-05'), now)).toBe('judging');
    expect(challengePhase(t('draft', '2026-10-01', '2026-10-20'), now)).toBe('draft');
  });

  it('allows only the defined admin transitions', () => {
    expect(adminTransition('publish', t('draft', '2026-10-01', '2026-10-20'), now)).toBe('active');
    expect(adminTransition('publish', t('draft', '2026-10-01', '2026-10-05'), now)).toBeNull();
    expect(adminTransition('complete', t('active', '2026-10-01', '2026-10-20'), now)).toBeNull();
    expect(adminTransition('archive', t('completed', '2026-10-01', '2026-10-05'), now)).toBe('archived');
    expect(adminTransition('resume', t('paused', '2026-10-01', '2026-10-05'), now)).toBe('judging');
  });

  it('moves scheduled and active challenges on with time', () => {
    expect(scheduledTransition(t('scheduled', '2026-10-01', '2026-10-20'), now)).toBe('active');
    expect(scheduledTransition(t('active', '2026-10-01', '2026-10-05'), now)).toBe('judging');
    expect(scheduledTransition(t('judging', '2026-10-01', '2026-10-05'), now)).toBeNull();
  });
});

describe('submission states', () => {
  it('follows the video and keeps unknown moderation states waiting', () => {
    expect(stateFromVideo('uploading')).toBe('pending_upload');
    expect(stateFromVideo('analyzing')).toBe('processing');
    expect(stateFromVideo('review_required')).toBe('pending_moderation');
    expect(stateFromVideo('human_review')).toBe('pending_moderation');
    expect(stateFromVideo('published')).toBeNull();
    expect(stateFromVideo('removed')).toBe('rejected');
    expect(stateFromVideo('failed')).toBe('failed_processing');
    expect(stateFromVideo('deleted')).toBe('withdrawn');
  });

  it('does not charge an attempt for a clip the platform could not process when retries are allowed', () => {
    expect(countsAsAttempt('failed_processing', true)).toBe(false);
    expect(countsAsAttempt('failed_processing', false)).toBe(true);
    expect(countsAsAttempt('approved', true)).toBe(true);
    expect(countsAsAttempt('withdrawn', false)).toBe(false);
  });
});

describe('eligibility', () => {
  const base: EligibilityInput = {
    actor: { status: 'active', ageBand: 'adult', roles: ['player'] },
    challenge: { phase: 'open', ageGroups: ['u16', 'u18', 'adult'], difficulty: 'beginner', hasSafetyNotes: false, requiresPartner: false, attemptLimit: 3 },
    participation: null, attemptsUsed: 0, othersInClip: false, consentOthers: false, safetyAck: false,
  };
  const code = (i: Partial<EligibilityInput> & { challenge?: Partial<EligibilityInput['challenge']> }) => {
    const r = checkEligibility({ ...base, ...i, challenge: { ...base.challenge, ...i.challenge } });
    return r.allowed ? 'ok' : r.code;
  };

  it('lets an eligible player in', () => expect(code({})).toBe('ok'));
  it('refuses closed challenges, other age groups, used attempts and closed participation', () => {
    expect(code({ challenge: { phase: 'judging' } })).toBe('CHALLENGE_NOT_OPEN');
    expect(code({ actor: { ...base.actor, ageBand: 'u13' } })).toBe('AGE_GROUP_NOT_ELIGIBLE');
    expect(code({ attemptsUsed: 3 })).toBe('ATTEMPTS_USED');
    expect(code({ participation: { status: 'disqualified' } })).toBe('PARTICIPATION_CLOSED');
  });
  it('needs consent for anyone else in the clip and a safety acknowledgement for hard tricks', () => {
    expect(code({ othersInClip: true })).toBe('CONSENT_OTHERS_REQUIRED');
    expect(code({ othersInClip: true, consentOthers: true })).toBe('ok');
    expect(code({ challenge: { difficulty: 'expert' } })).toBe('SAFETY_ACK_REQUIRED');
    expect(code({ challenge: { difficulty: 'expert' }, safetyAck: true })).toBe('ok');
  });
});

describe('verification agent', () => {
  const base = {
    durationMs: 20_000, minDurationS: 5, maxDurationS: 60, videoCreatedAt: new Date('2026-10-05'), startsAt: new Date('2026-10-01'), endsAt: new Date('2026-10-10'),
    duplicateOfOtherEntrant: false, footballPresent: true as boolean | null,
  };
  it('passes a clip that meets the observable requirements', () => expect(verifySubmission(base).pass).toBe(true));
  it('fails a clip that is too short, outside the window or copied', () => {
    expect(verifySubmission({ ...base, durationMs: 2000 }).reason).toMatch(/between 5 and 60/);
    expect(verifySubmission({ ...base, videoCreatedAt: new Date('2026-09-20') }).pass).toBe(false);
    expect(verifySubmission({ ...base, duplicateOfOtherEntrant: true }).reason).toMatch(/another player/);
  });
  it('never overrules the safety pipeline on football: a missing flag goes to the judge', () => {
    const r = verifySubmission({ ...base, footballPresent: false });
    expect(r.pass).toBe(true);
    expect(r.checks.find((c) => c.key === 'football')).toMatchObject({ pass: null });
  });
});

describe('anti-fraud agent', () => {
  const v = { isOwner: false, isGuardianOfOwner: false, blocked: false, votesUsed: 0, voterAccountAgeMs: 30 * 86_400_000, votingOpen: true };
  it('refuses self, guardian and over-limit votes, and sets aside votes from new accounts', () => {
    expect(voteDecision({ ...v, isOwner: true })).toMatchObject({ allowed: false, code: 'OWN_ENTRY' });
    expect(voteDecision({ ...v, isGuardianOfOwner: true })).toMatchObject({ allowed: false, code: 'OWN_ENTRY' });
    expect(voteDecision({ ...v, votesUsed: 3 })).toMatchObject({ allowed: false, code: 'VOTES_USED' });
    expect(voteDecision({ ...v, voterAccountAgeMs: 3_600_000 })).toEqual({ allowed: true, eligible: false, flag: 'new_account' });
    expect(voteDecision(v)).toEqual({ allowed: true, eligible: true, flag: null });
  });

  it('detects a burst of votes from young accounts', () => {
    const t0 = new Date('2026-10-05T10:00:00Z').getTime();
    const burst = Array.from({ length: 10 }, (_, i) => ({ submissionId: 's1', voterId: `u${i}`, createdAt: new Date(t0 + i * 30_000), voterAccountAgeMs: 86_400_000, eligible: true }));
    const organic = Array.from({ length: 10 }, (_, i) => ({ submissionId: 's2', voterId: `o${i}`, createdAt: new Date(t0 + i * 3_600_000), voterAccountAgeMs: 90 * 86_400_000, eligible: true }));
    expect(detectVoteBursts([...burst, ...organic]).map((f) => f.submissionId)).toEqual(['s1']);
  });
});

describe('recommendation agent', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const c = (id: string, difficulty: 'beginner' | 'intermediate' | 'advanced' | 'expert', extra: Partial<{ skillKey: string; category: 'freestyle' | 'shooting'; days: number }> = {}) => ({
    id, difficulty, category: extra.category ?? 'freestyle', skillKey: extra.skillKey ?? null, endsAt: new Date(now.getTime() + (extra.days ?? 10) * 86_400_000), participants: 3,
  });
  it('suggests the next rung of the ladder and skips joined or ended challenges', () => {
    const out = recommendChallenges([c('a', 'expert'), c('b', 'intermediate'), c('c', 'beginner'), c('d', 'intermediate', { days: -1 }), c('e', 'intermediate')],
      { bestApprovedDifficulty: 'beginner', categories: ['freestyle'], skills: [], joined: ['e'] }, now);
    expect(out[0]!.id).toBe('b');
    expect(out.map((o) => o.id)).not.toContain('d');
    expect(out.map((o) => o.id)).not.toContain('e');
  });
  it('starts newcomers on beginner challenges', () => {
    const out = recommendChallenges([c('x', 'expert'), c('y', 'beginner')], { bestApprovedDifficulty: null, categories: [], skills: [], joined: [] }, now);
    expect(out[0]!.id).toBe('y');
  });
});

describe('SEO agent', () => {
  const long = { en: 'Dribble through a slalom of six cones and back as fast as you can with close control and quick feet every single time.', ar: 'x' };
  const base = { phase: 'open' as const, visibility: 'public' as const, isTemplate: false, isDemo: false, title: { en: 'Cone Master', ar: 'x' }, description: long, instructions: long };
  it('indexes only useful public challenges', () => {
    expect(challengeIndexable(base).index).toBe(true);
    expect(challengeIndexable({ ...base, phase: 'draft' }).index).toBe(false);
    expect(challengeIndexable({ ...base, isDemo: true }).index).toBe(false);
    expect(challengeIndexable({ ...base, visibility: 'unlisted' }).index).toBe(false);
    expect(challengeIndexable({ ...base, description: { en: 'Short.', ar: '' }, instructions: { en: '', ar: '' } }).reason).toBe('thin');
  });
  it('trims descriptions on a word boundary', () => {
    const d = seoDescription('word '.repeat(60));
    expect(d.length).toBeLessThanOrEqual(155);
    expect(d.endsWith('…')).toBe(true);
  });
});

describe('notifications, streaks and head-to-head', () => {
  it('caps optional reminders but never results', () => {
    expect(noticeAllowed('challenge.ending_soon', 2)).toBe(false);
    expect(noticeAllowed('challenge.result', 50)).toBe(true);
  });
  it('counts consecutive ISO weeks', () => {
    expect(isoWeekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    const now = new Date('2026-10-21T00:00:00Z');
    expect(weeklyStreak([new Date('2026-10-20'), new Date('2026-10-13'), new Date('2026-10-06')], now)).toBe(3);
    expect(weeklyStreak([new Date('2026-10-13'), new Date('2026-09-29')], now)).toBe(1);
  });
  it('decides a head-to-head by the rubric direction', () => {
    expect(headToHeadWinner('lower', { userId: 'a', value: 10 }, { userId: 'b', value: 12 })).toEqual({ winner: 'a', decided: true });
    expect(headToHeadWinner('higher', { userId: 'a', value: null }, { userId: 'b', value: 3 })).toEqual({ winner: 'b', decided: true });
    expect(headToHeadWinner('higher', { userId: 'a', value: 3 }, { userId: 'b', value: 3 })).toEqual({ winner: null, decided: true });
  });
});
