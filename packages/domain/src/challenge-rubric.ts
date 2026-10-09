/**
 * Challenge rubrics: how an entry is scored, the same way for every entrant. A rubric is versioned
 * and frozen when its challenge starts. Scores are objective measurements (touches, time, hits) or
 * judges' criterion marks defined by the rubric, never an AI rating of a player.
 *
 * - measured: one `measure` component (the number), optional `penalty` components that each cost
 *   `perUnit` of the measure (seconds added to a time, touches taken off a count).
 * - judged: `criterion` components marked 0..max by judges; the value is the weighted mean on 0..100.
 */
import type { Bi } from './play.js';

export type RubricMethod = 'measured' | 'judged';
export type RubricUnit = 'count' | 'ms' | 'hits' | 'points';
export type RubricDirection = 'higher' | 'lower';
export type TieBreaker = 'fewer_penalties' | 'earliest_submission' | `higher_component:${string}` | `lower_component:${string}`;

export interface RubricComponent {
  key: string;
  kind: 'measure' | 'penalty' | 'criterion';
  label: Bi;
  /** Largest value a judge may enter. */
  max: number;
  /** criterion only: share of the final value; criteria weights add up to 1. */
  weight?: number;
  /** penalty only: how much of the measure one unit of this penalty costs. */
  perUnit?: number;
}

export interface Rubric {
  method: RubricMethod;
  unit: RubricUnit;
  direction: RubricDirection;
  components: RubricComponent[];
  /** Fixed number of attempts inside one clip (Target Shot); hits can never exceed it. */
  attempts?: number | null;
  tieBreakers: TieBreaker[];
  /** Judges needed before a score stands. */
  minJudges: 1 | 2 | 3;
  /** Largest difference (in the rubric's unit) between judges that still counts as agreement. */
  tolerance: number;
  /** How the challenge is scored, in plain words, shown on the challenge page. */
  summary: Bi;
  /** A model capability that could assist measurement; ignored unless it is validated (see AI_MEASUREMENT_CAPABILITIES). */
  aiCapability?: string | null;
}

/** A plain judged rubric, used when a challenge is created with neither a rubric nor a template. */
export const DEFAULT_RUBRIC: Rubric = {
  method: 'judged', unit: 'points', direction: 'higher',
  components: [
    { key: 'execution', kind: 'criterion', weight: 0.4, max: 10, label: { en: 'Execution', ar: 'التنفيذ' } },
    { key: 'control', kind: 'criterion', weight: 0.3, max: 10, label: { en: 'Control', ar: 'التحكم' } },
    { key: 'difficulty', kind: 'criterion', weight: 0.3, max: 10, label: { en: 'Difficulty', ar: 'الصعوبة' } },
  ],
  tieBreakers: ['earliest_submission'], minJudges: 1, tolerance: 15, aiCapability: null,
  summary: { en: 'A judge scores execution, control and difficulty out of 10; the weighted total is out of 100.', ar: 'يقيّم الحكم التنفيذ والتحكم والصعوبة من 10؛ والمجموع الموزون من 100.' },
};

const KEY = /^[a-z][a-z0-9_]{0,40}$/;

/** Rule checks beyond the shape (the API validates the shape with zod first). Empty when valid. */
export function rubricProblems(r: Rubric): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const c of r.components) {
    if (!KEY.test(c.key)) out.push(`component key "${c.key}" is not a lowercase identifier`);
    if (keys.has(c.key)) out.push(`component key "${c.key}" is used twice`);
    keys.add(c.key);
    if (!(c.max > 0)) out.push(`component "${c.key}" needs a positive max`);
  }
  const measures = r.components.filter((c) => c.kind === 'measure');
  const criteria = r.components.filter((c) => c.kind === 'criterion');
  const penalties = r.components.filter((c) => c.kind === 'penalty');
  if (r.method === 'measured') {
    if (measures.length !== 1) out.push('a measured rubric needs exactly one measure component');
    if (criteria.length) out.push('a measured rubric has no judged criteria');
    if (r.unit === 'points') out.push('a measured rubric counts touches, time or hits, not points');
    for (const p of penalties) if (!(p.perUnit && p.perUnit > 0)) out.push(`penalty "${p.key}" needs a positive perUnit`);
  } else {
    if (!criteria.length) out.push('a judged rubric needs at least one criterion');
    if (measures.length || penalties.length) out.push('a judged rubric only has criteria');
    if (r.unit !== 'points' || r.direction !== 'higher') out.push('a judged rubric scores points, higher is better');
    const sum = criteria.reduce((s, c) => s + (c.weight ?? 0), 0);
    if (Math.abs(sum - 1) > 0.001) out.push('criterion weights must add up to 1');
  }
  if (r.unit === 'hits') {
    if (!(r.attempts && r.attempts > 0)) out.push('a hits rubric needs a fixed number of attempts');
    else if (measures[0] && measures[0].max > r.attempts) out.push('hits cannot exceed the number of attempts');
  } else if (r.attempts) out.push('attempts only apply to a hits rubric');
  if (r.tolerance < 0) out.push('tolerance cannot be negative');
  for (const t of r.tieBreakers) {
    const m = /^(higher|lower)_component:(.+)$/.exec(t);
    if (m && !keys.has(m[2]!)) out.push(`tie-breaker "${t}" names an unknown component`);
  }
  return out;
}

export interface ScoreResult {
  value: number;
  penalties: number;
  components: Record<string, number>;
}

export class ScoreInputError extends Error {
  override name = 'ScoreInputError';
}

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;

/** One judge's (or one measurement's) score from component values. Throws ScoreInputError on bad input. */
export function computeScore(r: Rubric, input: Record<string, number>): ScoreResult {
  const unknown = Object.keys(input).filter((k) => !r.components.some((c) => c.key === k));
  if (unknown.length) throw new ScoreInputError(`unknown components: ${unknown.join(', ')}`);
  const components: Record<string, number> = {};
  for (const c of r.components) {
    const v = input[c.key];
    if (v === undefined || !Number.isFinite(v)) throw new ScoreInputError(`"${c.key}" is required`);
    if (v < 0 || v > c.max) throw new ScoreInputError(`"${c.key}" must be between 0 and ${c.max}`);
    const whole = c.kind === 'penalty' || (c.kind === 'measure' && (r.unit === 'count' || r.unit === 'hits'));
    if (whole && !Number.isInteger(v)) throw new ScoreInputError(`"${c.key}" must be a whole number`);
    components[c.key] = v;
  }
  if (r.method === 'judged') {
    const value = r.components.reduce((s, c) => s + (components[c.key]! / c.max) * (c.weight ?? 0) * 100, 0);
    return { value: round(value, 1), penalties: 0, components };
  }
  const measure = r.components.find((c) => c.kind === 'measure')!;
  if (r.unit === 'hits' && r.attempts && components[measure.key]! > r.attempts) throw new ScoreInputError(`hits cannot exceed ${r.attempts}`);
  const penalties = r.components.filter((c) => c.kind === 'penalty').reduce((s, c) => s + components[c.key]! * (c.perUnit ?? 0), 0);
  const raw = components[measure.key]!;
  const value = r.direction === 'lower' ? raw + penalties : Math.max(0, raw - penalties);
  return { value: round(value), penalties: round(penalties), components };
}

export type Consolidation =
  | { status: 'need_more'; have: number; need: number }
  | { status: 'disagree'; spread: number }
  | { status: 'agreed'; result: ScoreResult };

/**
 * Turns the judges' scores for one round into the submission's score. Disagreement beyond the
 * rubric's tolerance goes to an admin; it is never averaged away. A measured score takes the more
 * conservative agreeing value; a judged score takes the mean.
 */
export function consolidate(r: Rubric, scores: readonly ScoreResult[]): Consolidation {
  if (scores.length < r.minJudges) return { status: 'need_more', have: scores.length, need: r.minJudges };
  const values = scores.map((s) => s.value);
  const spread = round(Math.max(...values) - Math.min(...values));
  if (spread > r.tolerance) return { status: 'disagree', spread };
  if (r.method === 'measured') {
    const pick = [...scores].sort((a, b) => (r.direction === 'higher' ? a.value - b.value : b.value - a.value))[0]!;
    return { status: 'agreed', result: pick };
  }
  const components: Record<string, number> = {};
  for (const c of r.components) components[c.key] = round(scores.reduce((s, x) => s + x.components[c.key]!, 0) / scores.length, 2);
  return { status: 'agreed', result: { value: round(values.reduce((s, v) => s + v, 0) / values.length, 1), penalties: 0, components } };
}

export interface RankableEntry {
  submissionId: string;
  userId: string;
  value: number;
  penalties: number;
  components: Record<string, number>;
  submittedAt: string;
}

/** Leaderboard order: the rubric's direction, then its tie-breakers, then the submission id (stable). */
export function compareEntries(r: Rubric, a: RankableEntry, b: RankableEntry): number {
  if (a.value !== b.value) return r.direction === 'higher' ? b.value - a.value : a.value - b.value;
  for (const t of r.tieBreakers) {
    let d = 0;
    if (t === 'fewer_penalties') d = a.penalties - b.penalties;
    else if (t === 'earliest_submission') d = a.submittedAt.localeCompare(b.submittedAt);
    else {
      const m = /^(higher|lower)_component:(.+)$/.exec(t);
      if (m) {
        const av = a.components[m[2]!] ?? 0;
        const bv = b.components[m[2]!] ?? 0;
        d = m[1] === 'higher' ? bv - av : av - bv;
      }
    }
    if (d !== 0) return d;
  }
  return a.submissionId.localeCompare(b.submissionId);
}

/** Whether `a` is better than `b` under the rubric's direction (for personal bests). */
export function isBetter(r: Pick<Rubric, 'direction'>, a: number, b: number): boolean {
  return r.direction === 'higher' ? a > b : a < b;
}

/** Ranks with the best entry per player. Entries tied on everything share a rank (1, 2, 2, 4). */
export function rankEntries<E extends RankableEntry>(r: Rubric, entries: readonly E[]): (E & { rank: number })[] {
  const best = new Map<string, E>();
  for (const e of entries) {
    const prev = best.get(e.userId);
    if (!prev || compareEntries(r, e, prev) < 0) best.set(e.userId, e);
  }
  const sorted = [...best.values()].sort((a, b) => compareEntries(r, a, b));
  const out: (E & { rank: number })[] = [];
  sorted.forEach((e, i) => {
    const prev = out[i - 1];
    const tied = prev && compareEntries(r, { ...prev, submissionId: '' }, { ...e, submissionId: '' }) === 0;
    out.push({ ...e, rank: tied ? prev.rank : i + 1 });
  });
  return out;
}

/**
 * Model capabilities that could measure something in a clip. None is validated: there is no
 * evaluated model for counting touches, timing a course or counting target hits, so every entry
 * is scored by people. Flip one to validated only with an evaluation behind it.
 */
export const AI_MEASUREMENT_CAPABILITIES: Record<string, { validated: boolean; note: string }> = {
  juggle_count: { validated: false, note: 'no evaluated touch-counting model' },
  course_time: { validated: false, note: 'no evaluated start/finish detection' },
  target_hits: { validated: false, note: 'no evaluated target-hit detection' },
  move_recognition: { validated: false, note: 'skill tags exist, but not reliable enough to score a sequence' },
};

/** The Skill Scoring Agent's routing decision for a rubric. */
export function scoringRoute(r: Pick<Rubric, 'aiCapability'>): { route: 'human'; reason: string } | { route: 'ai_assisted'; capability: string } {
  const cap = r.aiCapability ? AI_MEASUREMENT_CAPABILITIES[r.aiCapability] : undefined;
  if (!r.aiCapability) return { route: 'human', reason: 'judged by people' };
  if (!cap) return { route: 'human', reason: `unknown capability ${r.aiCapability}` };
  if (!cap.validated) return { route: 'human', reason: cap.note };
  return { route: 'ai_assisted', capability: r.aiCapability };
}
