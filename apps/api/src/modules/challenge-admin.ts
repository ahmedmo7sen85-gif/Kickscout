/**
 * Challenge administration, all behind admin + MFA and audited: create from scratch or a template,
 * edit (fairness fields lock once a challenge starts), version the rubric until it freezes, move a
 * challenge through its states, assign judges, resolve appeals, recalculate results, and see fraud
 * signals and metrics. Nothing here needs a deploy.
 */
import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { DB } from '@fp/db';
import {
  AdminAppealList, AdminChallengeInput, AdminChallengeList, AdminChallengePatch, AdminChallengeQuery, AdminChallengeView, AppealResolveRequest,
  ChallengeFraudView, ChallengeJudgesRequest, ChallengeMetricsView, ChallengeTransitionRequest, RubricVersionRequest, TemplateInstallResult,
} from '@fp/contracts';
import type { ChallengeStatus, ChallengeTemplate, Rubric, SubmissionState } from '@fp/domain';
import { CHALLENGE_TEMPLATES, DEFAULT_RUBRIC, SUBMISSION_STATES, ScoreInputError, adminTransition, computeScore, detectVoteBursts, isMinor, rubricProblems } from '@fp/domain';
import { JUDGING_SLA_HOURS, STUCK_PROCESSING_HOURS, currentRubric, finalizeChallenge, sendChallengeNotice, writeSnapshots } from '@fp/worker/challenges';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import type { Ctx } from '../platform/route.js';
import { ApiError, conflict, notFound } from '../platform/errors.js';
import { audit, emit } from '../platform/events.js';
import { newId } from '../platform/ids.js';
import { agentLog, challengeQuery, loadChallenge, scoreViews, submissionQuery, toChallengeView } from './challenge-views.js';
import type { ChallengeRow } from './challenge-views.js';
import { applyScore } from './challenge-judging.js';

type Bi = { en: string; ar: string };
const IdParam = z.object({ id: z.uuid() });

/** Fields that decide who can enter and what counts; they cannot change once a challenge has started. */
const LOCKED_AFTER_START = ['startsAt', 'ageGroups', 'attemptLimit', 'retryFailed', 'minDurationS', 'maxDurationS', 'format', 'requiresPartner', 'recording', 'rules'] as const;
const STARTED: readonly ChallengeStatus[] = ['active', 'judging', 'completed', 'archived'];

function assertRubric(r: Rubric) {
  const problems = rubricProblems(r);
  if (problems.length) throw new ApiError(400, 'INVALID_RUBRIC', problems.join('; '));
}

function assertDates(startsAt: Date, endsAt: Date) {
  if (endsAt <= startsAt) throw new ApiError(400, 'INVALID_DATES', 'a challenge must end after it starts');
}

async function writeRules(tx: Transaction<DB>, challengeId: string, rules: readonly { kind: string; body: Bi }[]) {
  await tx.deleteFrom('challenge_rules').where('challenge_id', '=', challengeId).execute();
  if (rules.length) {
    await tx.insertInto('challenge_rules').values(rules.map((r, i) => ({ id: newId(), challenge_id: challengeId, kind: r.kind, body: JSON.stringify(r.body), sort: i }))).execute();
  }
}

async function addRubricVersion(tx: Transaction<DB>, challengeId: string, rubric: Rubric, actorId: string | null) {
  const last = await tx.selectFrom('challenge_rubric_versions').select((eb) => eb.fn.max('version').as('v')).where('challenge_id', '=', challengeId).executeTakeFirst();
  const id = newId();
  const version = Number(last?.v ?? 0) + 1;
  await tx.insertInto('challenge_rubric_versions').values({ id, challenge_id: challengeId, version, method: rubric.method, rubric: JSON.stringify(rubric), created_by: actorId }).execute();
  await tx.updateTable('challenges').set({ rubric_version_id: id, updated_at: sql`now()` }).where('id', '=', challengeId).execute();
  return { id, version };
}

type Input = z.output<typeof AdminChallengeInput>;

/** Row values for a challenge from admin input (or a template). */
function columns(b: Omit<Input, 'slug' | 'rules' | 'rubric' | 'fromTemplate'>) {
  return {
    title: JSON.stringify(b.title), description: JSON.stringify(b.description), instructions: JSON.stringify(b.instructions),
    skill_key: b.skillKey ?? null, hashtag: b.hashtag ?? null, starts_at: new Date(b.startsAt), ends_at: new Date(b.endsAt), timezone: b.timezone,
    format: b.format, category: b.category, difficulty: b.difficulty, age_groups: b.ageGroups, equipment: JSON.stringify(b.equipment),
    safety_notes: b.safetyNotes ? JSON.stringify(b.safetyNotes) : null, recording: JSON.stringify(b.recording),
    min_duration_s: b.minDurationS, max_duration_s: b.maxDurationS, attempt_limit: b.attemptLimit, retry_failed: b.retryFailed,
    requires_partner: b.requiresPartner, visibility: b.visibility, featured: b.featured, voting_enabled: b.votingEnabled,
    reward: b.reward ? JSON.stringify(b.reward) : null, demo_video_id: b.demoVideoId,
  };
}

function fromTemplateInput(t: ChallengeTemplate, startsAt: Date, endsAt: Date): Input {
  return {
    slug: t.slug, title: t.title, description: t.description, instructions: t.instructions, skillKey: (t.skillKey ?? undefined) as never, hashtag: t.hashtag,
    startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), timezone: 'UTC', format: t.format, category: t.category, difficulty: t.difficulty,
    ageGroups: t.ageGroups, equipment: t.equipment, safetyNotes: t.safetyNotes, recording: t.recording as never, minDurationS: t.minDurationS,
    maxDurationS: t.maxDurationS, attemptLimit: t.attemptLimit, retryFailed: true, requiresPartner: t.requiresPartner, visibility: 'public',
    featured: false, votingEnabled: true, reward: null, demoVideoId: null, rules: t.rules, rubric: t.rubric,
  };
}

/** A template row's settings as admin input (so a template edited in the admin is what gets copied). */
async function templateInput(deps: Deps, slug: string): Promise<{ input: Omit<Input, 'slug' | 'startsAt' | 'endsAt'>; templateKey: string | null }> {
  const t = await challengeQuery(deps.db).where('challenges.slug', '=', slug).where('challenges.is_template', '=', true).executeTakeFirst();
  if (!t) throw new ApiError(400, 'UNKNOWN_TEMPLATE', 'install the templates first, or pick another one');
  const rules = await deps.db.selectFrom('challenge_rules').select(['kind', 'body']).where('challenge_id', '=', t.id).orderBy('sort').execute();
  const rubric = (await currentRubric(deps.db, t.id))?.rubric;
  return {
    templateKey: t.template_key,
    input: {
      title: t.title as Bi, description: t.description as Bi, instructions: t.instructions as Bi, skillKey: (t.skill_key ?? undefined) as never,
      hashtag: t.hashtag ?? undefined, timezone: t.timezone, format: t.format as never, category: t.category as never, difficulty: t.difficulty as never,
      ageGroups: t.age_groups as never, equipment: t.equipment as Bi[], safetyNotes: (t.safety_notes as Bi | null) ?? null, recording: t.recording as never,
      minDurationS: t.min_duration_s, maxDurationS: t.max_duration_s, attemptLimit: t.attempt_limit, retryFailed: t.retry_failed,
      requiresPartner: t.requires_partner, visibility: t.visibility as never, featured: t.featured, votingEnabled: t.voting_enabled,
      reward: (t.reward as Bi | null) ?? null, demoVideoId: t.demo_video_id, rules: rules.map((r) => ({ kind: r.kind as never, body: r.body as Bi })), rubric,
    },
  };
}

// ---------------------------------------------------------------- views

async function adminViews(deps: Deps, rows: ChallengeRow[]): Promise<z.input<typeof AdminChallengeView>[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [rules, versions, judges, counts, appeals, setAside] = await Promise.all([
    deps.db.selectFrom('challenge_rules').select(['challenge_id', 'kind', 'body']).where('challenge_id', 'in', ids).orderBy('sort').execute(),
    deps.db.selectFrom('challenge_rubric_versions').select(['id', 'challenge_id', 'version', 'method', 'rubric', 'frozen_at', 'created_at']).where('challenge_id', 'in', ids).orderBy('version').execute(),
    deps.db.selectFrom('challenge_judges as j').innerJoin('profiles as p', 'p.user_id', 'j.user_id').select(['j.challenge_id', 'j.user_id', 'p.handle', 'p.display_name']).where('j.challenge_id', 'in', ids).execute(),
    deps.db.selectFrom('challenge_submissions').select(['challenge_id', 'state', sql<string>`count(*)`.as('n')]).where('challenge_id', 'in', ids).groupBy(['challenge_id', 'state']).execute(),
    deps.db.selectFrom('challenge_appeals as a').innerJoin('challenge_submissions as s', 's.id', 'a.submission_id').select(['s.challenge_id', sql<string>`count(*)`.as('n')])
      .where('s.challenge_id', 'in', ids).where('a.status', '=', 'open').groupBy('s.challenge_id').execute(),
    deps.db.selectFrom('challenge_votes').select(['challenge_id', sql<string>`count(*)`.as('n')]).where('challenge_id', 'in', ids).where('eligible', '=', false).groupBy('challenge_id').execute(),
  ]);
  return rows.map((c) => {
    const vs = versions.filter((v) => v.challenge_id === c.id);
    const cur = vs.find((v) => v.id === c.rubric_version_id);
    const { aiCapability: _a, ...pub } = (cur?.rubric ?? {}) as unknown as Rubric;
    return {
      ...toChallengeView(deps, c),
      status: c.status as never, isTemplate: c.is_template, templateKey: c.template_key, visibility: c.visibility as never,
      instructions: c.instructions as Bi, equipment: c.equipment as Bi[], safetyNotes: (c.safety_notes as Bi | null) ?? null, recording: c.recording as never,
      minDurationS: c.min_duration_s, maxDurationS: c.max_duration_s, attemptLimit: c.attempt_limit, retryFailed: c.retry_failed,
      requiresPartner: c.requires_partner, needsSafetyAck: c.safety_notes !== null || c.difficulty === 'advanced' || c.difficulty === 'expert',
      rules: rules.filter((r) => r.challenge_id === c.id).map((r) => ({ kind: r.kind as never, body: r.body as Bi })),
      rubric: cur ? { ...pub, attempts: pub.attempts ?? null, version: cur.version, frozen: cur.frozen_at !== null } : null,
      demoVideo: null, resultsPublishedAt: c.results_published_at?.toISOString() ?? null, indexable: false,
      rubricVersions: vs.map((v) => ({ id: v.id, version: v.version, method: v.method as never, frozen: v.frozen_at !== null, current: v.id === c.rubric_version_id, createdAt: v.created_at.toISOString() })),
      judges: judges.filter((j) => j.challenge_id === c.id).map((j) => ({ userId: j.user_id, handle: j.handle, displayName: j.display_name })),
      counts: Object.fromEntries(SUBMISSION_STATES.map((s) => [s, Number(counts.find((x) => x.challenge_id === c.id && x.state === s)?.n ?? 0)])) as Record<SubmissionState, number>,
      openAppeals: Number(appeals.find((a) => a.challenge_id === c.id)?.n ?? 0),
      setAsideVotes: Number(setAside.find((a) => a.challenge_id === c.id)?.n ?? 0),
    };
  });
}

async function oneAdminView(deps: Deps, id: string) {
  const row = await challengeQuery(deps.db).where('challenges.id', '=', id).executeTakeFirst();
  if (!row) throw notFound('challenge');
  return (await adminViews(deps, [row]))[0]!;
}

function guard(ctx: Ctx<any, any>) {
  ctx.authorize({ kind: 'challenge.manage' });
  return ctx.me();
}

/** Inserts a challenge with its rules and rubric v1. */
async function createChallenge(tx: Transaction<DB>, actorId: string | null, b: Input, extra: { isTemplate?: boolean; templateKey?: string | null } = {}) {
  const id = newId();
  const taken = await tx.selectFrom('challenges').select('id').where('slug', '=', b.slug).executeTakeFirst();
  if (taken) throw conflict('SLUG_TAKEN', 'that slug is taken');
  await tx.insertInto('challenges').values({
    id, slug: b.slug, created_by: actorId, status: 'draft', is_template: extra.isTemplate ?? false, template_key: extra.templateKey ?? null, ...columns(b),
  }).execute();
  await writeRules(tx, id, b.rules);
  await addRubricVersion(tx, id, (b.rubric as Rubric | undefined) ?? DEFAULT_RUBRIC, actorId);
  return id;
}

// ---------------------------------------------------------------- appeals

async function appealRows(deps: Deps, status: 'open' | 'all', id?: string) {
  let q = deps.db.selectFrom('challenge_appeals as a').innerJoin('challenge_submissions as s', 's.id', 'a.submission_id').innerJoin('challenges as c', 'c.id', 's.challenge_id')
    .select(['a.id', 'a.submission_id', 'a.reason', 'a.status', 'a.resolution', 'a.created_at', 'a.resolved_at', 's.state', 's.video_id', 'c.id as cid', 'c.slug', 'c.title']);
  if (status === 'open') q = q.where('a.status', '=', 'open');
  if (id) q = q.where('a.id', '=', id);
  const rows = await q.orderBy('a.created_at').limit(200).execute();
  const subs = rows.length ? await submissionQuery(deps.db).where('s.id', 'in', rows.map((r) => r.submission_id)).execute() : [];
  const scores = await scoreViews(deps.db, subs);
  return rows.map((r) => ({
    id: r.id, submissionId: r.submission_id, challenge: { id: r.cid, slug: r.slug, title: r.title as Bi }, reason: r.reason, status: r.status as never,
    resolution: r.resolution, createdAt: r.created_at.toISOString(), resolvedAt: r.resolved_at?.toISOString() ?? null,
    score: scores.get(r.submission_id) ?? null, state: r.state as never, videoId: r.video_id,
  }));
}

async function resolveAppeal(ctx: Ctx<any, z.output<typeof AppealResolveRequest>>) {
  const me = guard(ctx);
  const deps = ctx.deps;
  const { id } = IdParam.parse(ctx.params);
  const b = ctx.body;
  const now = deps.now();
  if (b.decision === 'uphold' && !b.rescore && !b.reinstate) throw new ApiError(400, 'NOTHING_TO_UPHOLD', 'an upheld appeal re-scores or reinstates the entry');
  await deps.db.transaction().execute(async (tx) => {
    const a = await tx.selectFrom('challenge_appeals').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!a) throw notFound('appeal');
    if (a.status !== 'open') throw conflict('APPEAL_CLOSED', `this appeal is ${a.status}`);
    const s = await tx.selectFrom('challenge_submissions as s').innerJoin('challenges as c', 'c.id', 's.challenge_id')
      .innerJoin('challenge_rubric_versions as rv', 'rv.id', 's.rubric_version_id').innerJoin('videos as v', 'v.id', 's.video_id')
      .select(['s.id', 's.user_id', 's.state', 's.judging_round', 's.challenge_id', 'c.slug', 'c.title', 'c.status as challenge_status', 'rv.id as rubric_id', 'rv.rubric', 'v.status as video_status'])
      .where('s.id', '=', a.submission_id).forUpdate().executeTakeFirstOrThrow();
    if (s.user_id === me.userId || me.guardianOf.includes(s.user_id)) throw new ApiError(403, 'CONFLICT_OF_INTEREST', 'another admin must decide this appeal');
    if (b.decision === 'uphold') {
      if (s.video_status !== 'published') throw conflict('VIDEO_NOT_PUBLISHED', 'the clip is not published, so the entry cannot be judged');
      if (b.rescore) {
        let result;
        try {
          result = computeScore(s.rubric as unknown as Rubric, b.rescore);
        } catch (err) {
          if (err instanceof ScoreInputError) throw new ApiError(400, 'INVALID_SCORE', err.message);
          throw err;
        }
        await tx.insertInto('challenge_submission_reviews').values({
          id: newId(), submission_id: s.id, reviewer_id: me.userId, kind: 'appeal', decision: 'score', round: s.judging_round,
          components: JSON.stringify(result.components), value: String(result.value), notes: b.resolution,
        }).execute();
        await applyScore(tx, s, result, [me.userId], [{ atMs: 0, note: `appeal: ${b.resolution.slice(0, 180)}` }], now);
      } else {
        // Reinstate for a fresh round of judging (a disqualification or verification rejection overturned).
        await tx.updateTable('challenge_scores').set({ review_status: 'overturned', superseded_at: now }).where('submission_id', '=', s.id).where('superseded_at', 'is', null).execute();
        await tx.updateTable('challenge_submissions').set({ state: 'pending_judging', state_reason: null, judging_round: s.judging_round + 1, updated_at: now }).where('id', '=', s.id).execute();
        await tx.insertInto('challenge_submission_reviews').values({ id: newId(), submission_id: s.id, reviewer_id: me.userId, kind: 'appeal', decision: 'reinstate', round: s.judging_round, notes: b.resolution }).execute();
      }
    }
    await tx.updateTable('challenge_appeals').set({ status: b.decision === 'uphold' ? 'upheld' : 'rejected', resolution: b.resolution, resolved_by: me.userId, resolved_at: now }).where('id', '=', id).execute();
    await audit(tx, { actorId: me.userId, action: `challenge.appeal_${b.decision === 'uphold' ? 'upheld' : 'rejected'}`, targetKind: 'challenge_submission', targetId: s.id, metadata: { appealId: id, rescore: !!b.rescore, reinstate: !!b.reinstate } });
    await sendChallengeNotice(tx, { userId: s.user_id, kind: 'challenge.appeal_update', dedupeKey: `appeal:${id}`, payload: { challengeSlug: s.slug, challenge: { slug: s.slug, title: s.title }, submissionId: s.id, decision: b.decision } });
    // A changed score after results are out: publish a recalculated leaderboard (the history stays).
    if (b.decision === 'uphold' && b.rescore && s.challenge_status === 'completed') {
      const rubric = await currentRubric(tx, s.challenge_id);
      if (rubric) await writeSnapshots(tx, s.challenge_id, rubric, 'recalculated', me.userId);
    }
  });
  return (await appealRows(deps, 'all', id))[0]!;
}

// ---------------------------------------------------------------- metrics

async function metrics(deps: Deps): Promise<z.input<typeof ChallengeMetricsView>> {
  const now = deps.now();
  const rows = await deps.db.selectFrom('challenges').select(['id', 'slug', 'title', 'status', 'starts_at'])
    .where('is_template', '=', false).where('status', '!=', 'draft').orderBy('ends_at', 'desc').limit(50).execute();
  const ids = rows.map((r) => r.id);
  const per = ids.length ? await deps.db.selectFrom('challenges as c').select((eb) => [
    'c.id',
    eb.selectFrom('challenge_participations as p').select(eb.fn.countAll<string>().as('n')).whereRef('p.challenge_id', '=', 'c.id').as('participants'),
    eb.selectFrom('challenge_participations as p').select(eb.fn.countAll<string>().as('n')).whereRef('p.challenge_id', '=', 'c.id').where('p.invited_by', 'is not', null).as('invited'),
    eb.selectFrom('challenge_submissions as s').select(eb.fn.countAll<string>().as('n')).whereRef('s.challenge_id', '=', 'c.id').as('submissions'),
    eb.selectFrom('challenge_submissions as s').select(eb.fn.countAll<string>().as('n')).whereRef('s.challenge_id', '=', 'c.id').where('s.state', '=', 'approved').as('approved'),
    eb.selectFrom('challenge_submissions as s').select(sql<string>`count(DISTINCT s.user_id)`.as('n')).whereRef('s.challenge_id', '=', 'c.id').where('s.state', '=', 'approved').as('approved_players'),
    eb.selectFrom('challenge_submissions as s').select(eb.fn.countAll<string>().as('n')).whereRef('s.challenge_id', '=', 'c.id').where('s.state', '=', 'disqualified').as('disqualified'),
    eb.selectFrom('challenge_submissions as s').innerJoin('videos as v', 'v.id', 's.video_id').select(eb.fn.countAll<string>().as('n')).whereRef('s.challenge_id', '=', 'c.id').where('v.status', 'in', ['rejected', 'removed']).as('mod_rejected'),
    eb.selectFrom('challenge_submissions as s').select(eb.fn.countAll<string>().as('n')).whereRef('s.challenge_id', '=', 'c.id').where('s.state', 'not in', ['pending_upload', 'processing', 'pending_moderation', 'withdrawn']).as('finished'),
    eb.selectFrom('challenge_submissions as s').select(sql<string>`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM s.approved_at - s.created_at) / 3600)`.as('h')).whereRef('s.challenge_id', '=', 'c.id').where('s.approved_at', 'is not', null).as('median_h'),
    eb.selectFrom('challenge_appeals as a').innerJoin('challenge_submissions as s', 's.id', 'a.submission_id').select(eb.fn.countAll<string>().as('n')).whereRef('s.challenge_id', '=', 'c.id').as('appeals'),
    eb.selectFrom('challenge_submission_reviews as r').innerJoin('challenge_submissions as s', 's.id', 'r.submission_id').select(eb.fn.countAll<string>().as('n')).whereRef('s.challenge_id', '=', 'c.id').where('r.kind', '=', 'admin').as('disagreements'),
    eb.selectFrom('challenge_votes as v').select(eb.fn.countAll<string>().as('n')).whereRef('v.challenge_id', '=', 'c.id').where('v.eligible', '=', true).as('votes'),
    eb.selectFrom('challenge_votes as v').select(eb.fn.countAll<string>().as('n')).whereRef('v.challenge_id', '=', 'c.id').where('v.eligible', '=', false).as('set_aside'),
    eb.selectFrom('challenge_scout_picks as sp').select(eb.fn.countAll<string>().as('n')).whereRef('sp.challenge_id', '=', 'c.id').as('picks'),
    eb.selectFrom('shortlist_players as si').innerJoin('challenge_participations as p', 'p.user_id', 'si.player_id').select(sql<string>`count(DISTINCT si.player_id)`.as('n'))
      .whereRef('p.challenge_id', '=', 'c.id').whereRef('si.added_at', '>=', 'c.starts_at').as('shortlisted'),
  ]).where('c.id', 'in', ids).execute() : [];
  const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
  const agents = await deps.db.selectFrom('challenge_agent_runs').select([
    'agent', sql<string>`count(*)`.as('runs'), sql<string>`count(*) FILTER (WHERE outcome = 'error')`.as('errors'),
    sql<string>`count(*) FILTER (WHERE outcome = 'routed_to_human')`.as('human'), sql<string>`count(*) FILTER (WHERE outcome = 'flagged')`.as('flagged'),
    sql<string | null>`avg(latency_ms)`.as('latency'), sql<string>`coalesce(sum(cost_usd_micros), 0)`.as('cost'),
  ]).where('created_at', '>', new Date(now.getTime() - 30 * 86_400_000)).groupBy('agent').execute();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const [stuck, backlog] = await Promise.all([
    deps.db.selectFrom('challenge_submissions').select((eb) => eb.fn.countAll<string>().as('n')).where('state', 'in', ['processing', 'pending_moderation']).where('updated_at', '<', hoursAgo(STUCK_PROCESSING_HOURS)).executeTakeFirstOrThrow(),
    deps.db.selectFrom('challenge_submissions').select((eb) => eb.fn.countAll<string>().as('n')).where('state', '=', 'pending_judging').where('updated_at', '<', hoursAgo(JUDGING_SLA_HOURS)).executeTakeFirstOrThrow(),
  ]);
  return {
    challenges: rows.map((c) => {
      const m = per.find((p) => p.id === c.id)!;
      const n = (v: unknown) => Number(v ?? 0);
      return {
        challenge: { id: c.id, slug: c.slug, title: c.title as Bi }, status: c.status as never,
        participants: n(m.participants), submissions: n(m.submissions), approved: n(m.approved),
        completionRate: ratio(n(m.approved_players), n(m.participants)), moderationRejectionRate: ratio(n(m.mod_rejected), n(m.finished)),
        disqualified: n(m.disqualified), medianHoursToResult: m.median_h === null ? null : Math.round(Number(m.median_h) * 10) / 10,
        appeals: n(m.appeals), appealRate: ratio(n(m.appeals), n(m.approved) + n(m.disqualified)), disagreements: n(m.disagreements),
        eligibleVotes: n(m.votes), setAsideVotes: n(m.set_aside), scoutPicks: n(m.picks), scoutShortlists: n(m.shortlisted), invitedEntrants: n(m.invited),
      };
    }),
    agents: agents.map((a) => ({
      agent: a.agent, runs: Number(a.runs), errors: Number(a.errors), routedToHuman: Number(a.human), flagged: Number(a.flagged),
      avgLatencyMs: a.latency === null ? null : Math.round(Number(a.latency)), costUsd: Number(a.cost) / 1e6,
    })),
    stuckSubmissions: Number(stuck.n), judgingBacklog: Number(backlog.n),
  };
}

// ---------------------------------------------------------------- routes

export const challengeAdminRoutes = [
  route(
    { method: 'get', path: '/v1/admin/challenges', summary: 'Challenges (or templates) for admins', tag: 'admin', auth: 'user', query: AdminChallengeQuery, response: AdminChallengeList },
    async (ctx) => {
      guard(ctx);
      let q = challengeQuery(ctx.deps.db).where('challenges.is_template', '=', ctx.query.templates);
      if (ctx.query.status) q = q.where('challenges.status', '=', ctx.query.status);
      const rows = await q.orderBy('challenges.starts_at', 'desc').limit(200).execute();
      return { items: await adminViews(ctx.deps, rows) };
    },
  ),
  route(
    { method: 'get', path: '/v1/admin/challenges/metrics', summary: 'Challenge and agent metrics', tag: 'admin', auth: 'user', response: ChallengeMetricsView },
    async (ctx) => {
      guard(ctx);
      return metrics(ctx.deps);
    },
  ),
  route(
    { method: 'post', path: '/v1/admin/challenges/templates/install', summary: 'Install the starter templates (idempotent by slug)', tag: 'admin', auth: 'user', response: TemplateInstallResult },
    async (ctx) => {
      const me = guard(ctx);
      const installed: string[] = [];
      const skipped: string[] = [];
      const now = ctx.deps.now();
      for (const t of CHALLENGE_TEMPLATES) {
        assertRubric(t.rubric);
        const done = await ctx.deps.db.transaction().execute(async (tx) => {
          const has = await tx.selectFrom('challenges').select('id').where('slug', '=', t.slug).executeTakeFirst();
          if (has) return false;
          // Template dates are placeholders: a challenge made from it sets its own.
          const id = await createChallenge(tx, me.userId, fromTemplateInput(t, now, new Date(now.getTime() + 7 * 86_400_000)), { isTemplate: true, templateKey: t.templateKey });
          await audit(tx, { actorId: me.userId, action: 'challenge.template_installed', targetKind: 'challenge', targetId: id, metadata: { slug: t.slug } });
          return true;
        });
        (done ? installed : skipped).push(t.slug);
      }
      return { installed, skipped };
    },
  ),
  route(
    { method: 'get', path: '/v1/admin/challenges/:id', summary: 'One challenge for admins', tag: 'admin', auth: 'user', response: AdminChallengeView },
    async (ctx) => {
      guard(ctx);
      return oneAdminView(ctx.deps, IdParam.parse(ctx.params).id);
    },
  ),
  route(
    { method: 'post', path: '/v1/admin/challenges', summary: 'Create a challenge as a draft (from scratch or a template)', tag: 'admin', auth: 'user', body: AdminChallengeInput, response: AdminChallengeView, status: 201 },
    async (ctx) => {
      const me = guard(ctx);
      const raw = (ctx.req.body ?? {}) as Record<string, unknown>;
      let b = ctx.body;
      let templateKey: string | null = null;
      if (b.fromTemplate) {
        // Template settings, then whatever the request set explicitly on top.
        const t = await templateInput(ctx.deps, b.fromTemplate);
        templateKey = t.templateKey;
        const explicit = Object.fromEntries(Object.entries(b).filter(([k]) => k in raw));
        b = { ...b, ...t.input, ...explicit, rubric: b.rubric ?? t.input.rubric };
      }
      if (!b.title || !b.description) throw new ApiError(400, 'VALIDATION_FAILED', 'a title and description are required');
      assertDates(new Date(b.startsAt), new Date(b.endsAt));
      if (b.minDurationS > b.maxDurationS) throw new ApiError(400, 'INVALID_DURATION', 'the minimum length is longer than the maximum');
      if (b.rubric) assertRubric(b.rubric as Rubric);
      const id = await ctx.deps.db.transaction().execute(async (tx) => {
        const cid = await createChallenge(tx, me.userId, b, { templateKey });
        await audit(tx, { actorId: me.userId, action: 'challenge.created', targetKind: 'challenge', targetId: cid, metadata: { fromTemplate: b.fromTemplate ?? null } });
        await emit(tx, 'challenge.created', { challengeId: cid });
        return cid;
      });
      return oneAdminView(ctx.deps, id);
    },
  ),
  route(
    { method: 'patch', path: '/v1/admin/challenges/:id', summary: 'Edit a challenge (entry rules lock once it starts)', tag: 'admin', auth: 'user', body: AdminChallengePatch, response: AdminChallengeView },
    async (ctx) => {
      const me = guard(ctx);
      const { id } = IdParam.parse(ctx.params);
      const raw = (ctx.req.body ?? {}) as Record<string, unknown>;
      await ctx.deps.db.transaction().execute(async (tx) => {
        const c = await tx.selectFrom('challenges').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!c) throw notFound('challenge');
        const p = Object.fromEntries(Object.entries(ctx.body).filter(([k]) => k in raw)) as z.output<typeof AdminChallengePatch>;
        if (STARTED.includes(c.status as ChallengeStatus)) {
          const locked = LOCKED_AFTER_START.filter((k) => k in p);
          if (locked.length) throw new ApiError(409, 'CHALLENGE_STARTED', `cannot change ${locked.join(', ')} after the challenge started`);
          if (p.endsAt && new Date(p.endsAt) < c.ends_at) throw new ApiError(409, 'CHALLENGE_STARTED', 'a started challenge can be extended, not shortened');
        }
        const starts = p.startsAt ? new Date(p.startsAt) : c.starts_at;
        const ends = p.endsAt ? new Date(p.endsAt) : c.ends_at;
        assertDates(starts, ends);
        if ((p.minDurationS ?? c.min_duration_s) > (p.maxDurationS ?? c.max_duration_s)) throw new ApiError(400, 'INVALID_DURATION', 'the minimum length is longer than the maximum');
        const set: Record<string, unknown> = {};
        const map: Record<string, [string, (v: never) => unknown]> = {
          title: ['title', JSON.stringify], description: ['description', JSON.stringify], instructions: ['instructions', JSON.stringify],
          skillKey: ['skill_key', (v) => v ?? null], hashtag: ['hashtag', (v) => v ?? null], startsAt: ['starts_at', (v) => new Date(v)], endsAt: ['ends_at', (v) => new Date(v)],
          timezone: ['timezone', (v) => v], format: ['format', (v) => v], category: ['category', (v) => v], difficulty: ['difficulty', (v) => v],
          ageGroups: ['age_groups', (v) => v], equipment: ['equipment', JSON.stringify], safetyNotes: ['safety_notes', (v) => (v ? JSON.stringify(v) : null)],
          recording: ['recording', JSON.stringify], minDurationS: ['min_duration_s', (v) => v], maxDurationS: ['max_duration_s', (v) => v],
          attemptLimit: ['attempt_limit', (v) => v], retryFailed: ['retry_failed', (v) => v], requiresPartner: ['requires_partner', (v) => v],
          visibility: ['visibility', (v) => v], featured: ['featured', (v) => v], votingEnabled: ['voting_enabled', (v) => v],
          reward: ['reward', (v) => (v ? JSON.stringify(v) : null)], demoVideoId: ['demo_video_id', (v) => v],
        };
        for (const [k, v] of Object.entries(p)) if (map[k]) set[map[k][0]] = map[k][1](v as never);
        if (Object.keys(set).length) await tx.updateTable('challenges').set({ ...set, updated_at: ctx.deps.now() } as never).where('id', '=', id).execute();
        if (p.rules) await writeRules(tx, id, p.rules);
        await audit(tx, { actorId: me.userId, action: 'challenge.updated', targetKind: 'challenge', targetId: id, metadata: { fields: Object.keys(p) } });
      });
      return oneAdminView(ctx.deps, id);
    },
  ),
  route(
    { method: 'post', path: '/v1/admin/challenges/:id/rubric', summary: 'Add a rubric version (only until the challenge starts and it freezes)', tag: 'admin', auth: 'user', body: RubricVersionRequest, response: AdminChallengeView, status: 201 },
    async (ctx) => {
      const me = guard(ctx);
      const { id } = IdParam.parse(ctx.params);
      assertRubric(ctx.body.rubric as Rubric);
      await ctx.deps.db.transaction().execute(async (tx) => {
        const c = await tx.selectFrom('challenges').select(['id', 'status', 'rubric_version_id']).where('id', '=', id).forUpdate().executeTakeFirst();
        if (!c) throw notFound('challenge');
        const cur = c.rubric_version_id ? await tx.selectFrom('challenge_rubric_versions').select('frozen_at').where('id', '=', c.rubric_version_id).executeTakeFirst() : null;
        if (cur?.frozen_at || STARTED.includes(c.status as ChallengeStatus)) throw new ApiError(409, 'RUBRIC_FROZEN', 'the rubric is frozen once the challenge starts');
        const v = await addRubricVersion(tx, id, ctx.body.rubric as Rubric, me.userId);
        await audit(tx, { actorId: me.userId, action: 'challenge.rubric_versioned', targetKind: 'challenge', targetId: id, metadata: { version: v.version } });
      });
      return oneAdminView(ctx.deps, id);
    },
  ),
  route(
    { method: 'post', path: '/v1/admin/challenges/:id/transition', summary: 'Publish, pause, resume, cancel, close, complete (publish results) or archive', tag: 'admin', auth: 'user', body: ChallengeTransitionRequest, response: AdminChallengeView },
    async (ctx) => {
      const me = guard(ctx);
      const { id } = IdParam.parse(ctx.params);
      const deps = ctx.deps;
      const now = deps.now();
      const c = await loadChallenge(deps, id, { staff: true });
      const to = adminTransition(ctx.body.action, { status: c.status as ChallengeStatus, startsAt: c.starts_at, endsAt: c.ends_at }, now);
      if (!to) throw new ApiError(409, 'INVALID_TRANSITION', `cannot ${ctx.body.action} a ${c.status} challenge`);
      if (c.is_template && ctx.body.action === 'publish') throw new ApiError(409, 'INVALID_TRANSITION', 'templates are never published; create a challenge from it');
      if (to === 'completed') {
        const r = await finalizeChallenge(deps.db, id, { actorId: me.userId, force: ctx.body.force, log: agentLog(ctx.req.log) });
        if (!r.completed) {
          throw new ApiError(409, r.reason === 'entries_pending' ? 'ENTRIES_PENDING' : 'INVALID_TRANSITION',
            r.reason === 'entries_pending' ? `${r.pending} entries are still in moderation or judging; finish them or force` : 'this challenge is not in judging');
        }
        return oneAdminView(deps, id);
      }
      await deps.db.transaction().execute(async (tx) => {
        if (ctx.body.action === 'publish') {
          const rubric = await currentRubric(tx, id);
          if (!rubric) throw new ApiError(409, 'NO_RUBRIC', 'add a rubric first');
          assertRubric(rubric.rubric);
        }
        const moved = await tx.updateTable('challenges').set({ status: to, updated_at: now }).where('id', '=', id).where('status', '=', c.status).returning('id').executeTakeFirst();
        if (!moved) throw conflict('STATE_CHANGED', 'this challenge changed; reload and try again');
        if (to === 'active' || to === 'judging') {
          await tx.updateTable('challenge_rubric_versions').set({ frozen_at: now }).where('id', '=', c.rubric_version_id!).where('frozen_at', 'is', null).execute();
        }
        await audit(tx, { actorId: me.userId, action: 'challenge.status_changed', targetKind: 'challenge', targetId: id, metadata: { from: c.status, to, action: ctx.body.action } });
        await emit(tx, 'challenge.status_changed', { challengeId: id, from: c.status, to });
      });
      return oneAdminView(deps, id);
    },
  ),
  route(
    { method: 'put', path: '/v1/admin/challenges/:id/judges', summary: 'Set the judges of a challenge (adults with MFA)', tag: 'admin', auth: 'user', body: ChallengeJudgesRequest, response: AdminChallengeView },
    async (ctx) => {
      const me = guard(ctx);
      const { id } = IdParam.parse(ctx.params);
      const ids = [...new Set(ctx.body.userIds)];
      await ctx.deps.db.transaction().execute(async (tx) => {
        const c = await tx.selectFrom('challenges').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
        if (!c) throw notFound('challenge');
        if (ids.length) {
          const people = await tx.selectFrom('users').leftJoin('age_records', 'age_records.user_id', 'users.id').select(['users.id', 'users.status', 'age_records.age_band']).where('users.id', 'in', ids).execute();
          const bad = ids.filter((u) => { const p = people.find((x) => x.id === u); return !p || p.status !== 'active' || !p.age_band || isMinor(p.age_band as never); });
          if (bad.length) throw new ApiError(400, 'INVALID_JUDGES', 'judges must be active adult accounts');
        }
        await tx.deleteFrom('challenge_judges').where('challenge_id', '=', id).execute();
        if (ids.length) await tx.insertInto('challenge_judges').values(ids.map((u) => ({ challenge_id: id, user_id: u, added_by: me.userId }))).execute();
        await audit(tx, { actorId: me.userId, action: 'challenge.judges_set', targetKind: 'challenge', targetId: id, metadata: { judges: ids } });
      });
      return oneAdminView(ctx.deps, id);
    },
  ),
  route(
    { method: 'post', path: '/v1/admin/challenges/:id/recalculate', summary: 'Recompute and publish a recalculated leaderboard (results history is kept)', tag: 'admin', auth: 'user', response: z.object({ scopes: z.array(z.string()) }) },
    async (ctx) => {
      const me = guard(ctx);
      const { id } = IdParam.parse(ctx.params);
      return ctx.deps.db.transaction().execute(async (tx) => {
        const c = await tx.selectFrom('challenges').select(['status']).where('id', '=', id).forUpdate().executeTakeFirst();
        if (!c) throw notFound('challenge');
        if (c.status !== 'completed') throw new ApiError(409, 'NOT_COMPLETED', 'only published results are recalculated');
        const rubric = (await currentRubric(tx, id))!;
        const scopes = await writeSnapshots(tx, id, rubric, 'recalculated', me.userId);
        await audit(tx, { actorId: me.userId, action: 'challenge.recalculated', targetKind: 'challenge', targetId: id, metadata: { scopes } });
        return { scopes };
      });
    },
  ),
  route(
    { method: 'get', path: '/v1/admin/challenges/:id/fraud', summary: 'Anti-Fraud signals: duplicate clips, vote bursts, set-aside votes', tag: 'admin', auth: 'user', response: ChallengeFraudView },
    async (ctx) => {
      guard(ctx);
      const { id } = IdParam.parse(ctx.params);
      const db = ctx.deps.db;
      const dups = await db.selectFrom('challenge_submissions as s').innerJoin('videos as v', 'v.id', 's.video_id')
        .innerJoin('videos as o', (j) => j.onRef('o.sha256', '=', 'v.sha256').onRef('o.id', '<>', 'v.id').onRef('o.owner_user_id', '<>', 'v.owner_user_id'))
        .select(['s.id', 's.video_id', 'o.id as other']).where('s.challenge_id', '=', id).where('v.sha256', 'is not', null).limit(200).execute();
      const votes = await db.selectFrom('challenge_votes as cv').innerJoin('users as u', 'u.id', 'cv.voter_id')
        .select(['cv.submission_id', 'cv.voter_id', 'cv.created_at', 'cv.eligible', 'u.created_at as account_created']).where('cv.challenge_id', '=', id).execute();
      const rows = votes.map((v) => ({ submissionId: v.submission_id, voterId: v.voter_id, createdAt: v.created_at, voterAccountAgeMs: v.created_at.getTime() - v.account_created.getTime(), eligible: v.eligible }));
      const aside = await db.selectFrom('challenge_votes').select(['submission_id', 'flag_reason', sql<string>`count(*)`.as('n')])
        .where('challenge_id', '=', id).where('eligible', '=', false).groupBy(['submission_id', 'flag_reason']).execute();
      return {
        duplicates: dups.map((d) => ({ submissionId: d.id, videoId: d.video_id, matchesVideoId: d.other })),
        voteBursts: detectVoteBursts(rows),
        setAsideVotes: aside.map((a) => ({ submissionId: a.submission_id, count: Number(a.n), reason: a.flag_reason ?? 'unknown' })),
      };
    },
  ),
  route(
    { method: 'get', path: '/v1/admin/challenge-appeals', summary: 'Appeals (open by default)', tag: 'admin', auth: 'user', query: z.object({ status: z.enum(['open', 'all']).default('open') }), response: AdminAppealList },
    async (ctx) => {
      guard(ctx);
      return { items: await appealRows(ctx.deps, ctx.query.status) };
    },
  ),
  route(
    { method: 'post', path: '/v1/admin/challenge-appeals/:id/resolve', summary: 'Uphold (re-score or reinstate) or reject an appeal', tag: 'admin', auth: 'user', body: AppealResolveRequest, response: AdminAppealList.shape.items.element },
    async (ctx) => resolveAppeal(ctx),
  ),
];
