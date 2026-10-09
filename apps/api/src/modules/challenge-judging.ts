/**
 * Judging challenge entries. Judging is blind (judges see the clip, the rules and the player's
 * claimed number, never who the player is) and human: no validated model measures these skills
 * yet, so the Skill Scoring Agent routes every entry here. The rubric decides how many judges must
 * agree; a disagreement beyond its tolerance, or a judge asking for help, goes to an admin and is
 * never averaged away. A measured score that differs from the player's own claim needs a second
 * judge even when the rubric asks for one.
 */
import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { DB } from '@fp/db';
import { JudgeItemView, JudgeQueueQuery, JudgeQueueView, JudgeReviewRequest, JudgeReviewResult } from '@fp/contracts';
import type { Actor, Rubric, ScoreResult } from '@fp/domain';
import { ScoreInputError, can, computeScore, consolidate } from '@fp/domain';
import { onSubmissionApproved, recordAgentRun, sendChallengeNotice } from '@fp/worker/challenges';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import type { Ctx } from '../platform/route.js';
import { ApiError, conflict, forbidden, notFound } from '../platform/errors.js';
import { audit } from '../platform/events.js';
import { newId } from '../platform/ids.js';
import { decodeCursor, encodeCursor } from '../platform/cursor.js';
import { mediaUrl } from '../platform/storage.js';
import { agentLog, isStaff, publicRubric } from './challenge-views.js';

type Bi = { en: string; ar: string };
type Db = Deps['db'] | Transaction<DB>;
const IdParam = z.object({ id: z.uuid() });

function judgeQuery(db: Db) {
  return db.selectFrom('challenge_submissions as s')
    .innerJoin('challenges as c', 'c.id', 's.challenge_id')
    .innerJoin('videos as v', 'v.id', 's.video_id')
    .innerJoin('privacy_settings as ps', 'ps.user_id', 's.user_id')
    .innerJoin('challenge_rubric_versions as rv', 'rv.id', 's.rubric_version_id')
    .select([
      's.id', 's.user_id', 's.challenge_id', 's.state', 's.attempt_no', 's.claimed_value', 's.judging_round', 's.verification', 's.created_at',
      'c.slug', 'c.title', 'v.id as video_id', 'v.playback_key', 'v.thumbnail_key', 'v.duration_ms',
      sql<boolean>`v.visibility = 'public' AND ps.profile_visibility = 'public'`.as('clip_public'),
      'rv.id as rubric_id', 'rv.version as rubric_version', 'rv.rubric', 'rv.frozen_at',
      (eb) => eb.exists(eb.selectFrom('challenge_appeals as a').select('a.id').whereRef('a.submission_id', '=', 's.id').where('a.status', '=', 'open')).as('appeal_open'),
    ]);
}
type JudgeRow = Awaited<ReturnType<ReturnType<typeof judgeQuery>['executeTakeFirstOrThrow']>>;

/** Reviews of the current round, and whether that round needs an admin (escalated or disagreeing). */
async function roundState(db: Db, s: Pick<JudgeRow, 'id' | 'judging_round' | 'rubric' | 'claimed_value'>) {
  const rubric = s.rubric as unknown as Rubric;
  const reviews = await db.selectFrom('challenge_submission_reviews').select(['reviewer_id', 'decision', 'components', 'value', 'evidence'])
    .where('submission_id', '=', s.id).where('round', '=', s.judging_round).where('kind', 'in', ['judging', 'admin']).execute();
  const scores: ScoreResult[] = reviews.filter((r) => r.decision === 'score' && r.components)
    .map((r) => computeScore(rubric, r.components as Record<string, number>));
  const claim = s.claimed_value === null ? null : Number(s.claimed_value);
  const mismatch = rubric.method === 'measured' && claim !== null && scores.some((x) => Math.abs(x.value - claim) > rubric.tolerance);
  const minJudges = mismatch ? Math.max(rubric.minJudges, 2) : rubric.minJudges;
  const c = consolidate({ ...rubric, minJudges: minJudges as 1 | 2 | 3 }, scores);
  const escalated = reviews.some((r) => r.decision === 'escalate' || r.decision === 'disqualify');
  return { rubric, reviews, scores, mismatch, minJudges, consolidation: c, needsAdmin: escalated || c.status === 'disagree' };
}

async function assignedTo(db: Db, userId: string) {
  return (await db.selectFrom('challenge_judges').select('challenge_id').where('user_id', '=', userId).execute()).map((r) => r.challenge_id);
}

async function toItem(deps: Deps, me: Actor, s: JudgeRow): Promise<z.input<typeof JudgeItemView>> {
  const st = await roundState(deps.db, s);
  const checks = ((s.verification as { key: string; pass: boolean | null; detail?: string }[] | null) ?? [])
    .map((c) => ({ key: c.key, pass: c.pass, detail: c.detail ?? null }));
  const flags: z.input<typeof JudgeItemView>['flags'] = [];
  if (st.consolidation.status === 'disagree' || st.reviews.some((r) => r.decision === 'escalate' || r.decision === 'disqualify')) flags.push('disagreement');
  if (st.mismatch) flags.push('claim_mismatch');
  if (checks.some((c) => c.key === 'football' && c.pass === null && c.detail)) flags.push('football_not_detected');
  if (s.appeal_open) flags.push('appeal');
  return {
    submissionId: s.id, challenge: { id: s.challenge_id, slug: s.slug, title: s.title as Bi },
    rubric: publicRubric({ id: s.rubric_id, version: s.rubric_version, rubric: st.rubric, frozen: s.frozen_at !== null }),
    video: {
      id: s.video_id, durationMs: s.duration_ms,
      playbackUrl: s.playback_key ? mediaUrl(deps.config.CDN_BASE_URL, s.playback_key) : null,
      thumbnailUrl: s.thumbnail_key ? mediaUrl(deps.config.CDN_BASE_URL, s.thumbnail_key) : null,
    },
    attemptNo: s.attempt_no, claimedValue: s.claimed_value === null ? null : Number(s.claimed_value), round: s.judging_round,
    reviewsThisRound: st.reviews.filter((r) => r.decision === 'score').length, judgesNeeded: st.minJudges,
    reviewedByMe: st.reviews.some((r) => r.reviewer_id === me.userId), checks, flags, createdAt: s.created_at.toISOString(),
  };
}

/** Throws unless `me` may judge this entry now. */
function authorizeJudge(ctx: Ctx<any, any>, s: JudgeRow, assigned: readonly string[]) {
  ctx.authorize({ kind: 'challenge.judge', assigned: assigned.includes(s.challenge_id), ownerId: s.user_id, clipPublic: !!s.clip_public });
}

/**
 * Writes the submission's (new) current score and approves it, in the caller's transaction. Used by
 * judging and by an admin upholding an appeal with a re-score.
 */
export async function applyScore(tx: Transaction<DB>, s: { id: string; rubric_id: string; rubric: unknown }, result: ScoreResult, judges: readonly string[], evidence: unknown[], now: Date) {
  const rubric = s.rubric as Rubric;
  await tx.updateTable('challenge_scores').set({ superseded_at: now }).where('submission_id', '=', s.id).where('superseded_at', 'is', null).execute();
  const scoreId = newId();
  await tx.insertInto('challenge_scores').values({
    id: scoreId, submission_id: s.id, rubric_version_id: s.rubric_id, method: rubric.method, value: String(result.value), penalties: String(result.penalties),
    confidence: null, evidence: JSON.stringify(evidence), review_status: 'confirmed', judges: [...new Set(judges)],
  }).execute();
  await tx.insertInto('challenge_score_components').values(Object.entries(result.components).map(([key, value]) => ({ score_id: scoreId, key, value: String(value) }))).execute();
  await tx.updateTable('challenge_submissions').set({ state: 'approved', state_reason: null, updated_at: now, approved_at: sql`coalesce(approved_at, ${now})` })
    .where('id', '=', s.id).execute();
  await onSubmissionApproved(tx, s.id);
  return scoreId;
}

export async function disqualify(tx: Transaction<DB>, s: { id: string; user_id: string; slug: string; title: unknown }, reason: string, now: Date) {
  await tx.updateTable('challenge_scores').set({ superseded_at: now }).where('submission_id', '=', s.id).where('superseded_at', 'is', null).execute();
  await tx.updateTable('challenge_submissions').set({ state: 'disqualified', state_reason: reason.slice(0, 500), updated_at: now }).where('id', '=', s.id).execute();
  await sendChallengeNotice(tx, {
    userId: s.user_id, kind: 'challenge.disqualified', dedupeKey: `sub:${s.id}:dq:${now.getTime()}`,
    payload: { challengeSlug: s.slug, submissionId: s.id, challenge: { slug: s.slug, title: s.title }, reason },
  });
}

async function review(ctx: Ctx<any, z.output<typeof JudgeReviewRequest>>): Promise<z.input<typeof JudgeReviewResult>> {
  const me = ctx.me();
  const deps = ctx.deps;
  const { id } = IdParam.parse(ctx.params);
  const b = ctx.body;
  const now = deps.now();
  const admin = me.roles.includes('admin') && me.mfa;
  const assigned = await assignedTo(deps.db, me.userId);
  const out = await deps.db.transaction().execute(async (tx) => {
    await tx.selectFrom('challenge_submissions').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
    const s = await judgeQuery(tx).where('s.id', '=', id).executeTakeFirst();
    if (!s) throw notFound('entry');
    authorizeJudge(ctx, s, assigned);
    if (s.state !== 'pending_judging') throw conflict('NOT_PENDING', `this entry is ${s.state}`);
    const before = await roundState(tx, s);
    if (before.needsAdmin && !admin) throw forbidden('ADMIN_REVIEW', 'this entry is waiting for an admin');
    if (!before.needsAdmin && before.reviews.some((r) => r.reviewer_id === me.userId)) throw conflict('ALREADY_REVIEWED', 'you already judged this entry');

    let score: ScoreResult | null = null;
    if (b.decision === 'score') {
      try {
        score = computeScore(before.rubric, b.components!);
      } catch (err) {
        if (err instanceof ScoreInputError) throw new ApiError(400, 'INVALID_SCORE', err.message);
        throw err;
      }
    }
    // An admin settling an escalated entry decides it; everyone else adds one judge's review.
    const settling = before.needsAdmin;
    await tx.insertInto('challenge_submission_reviews').values({
      id: newId(), submission_id: id, reviewer_id: me.userId, kind: settling ? 'admin' : 'judging', decision: b.decision, round: s.judging_round,
      components: score ? JSON.stringify(score.components) : null, value: score ? String(score.value) : null,
      evidence: JSON.stringify(b.evidence), notes: b.notes ?? null,
    }).execute().catch((err: { code?: string }) => {
      if (err.code === '23505') throw conflict('ALREADY_REVIEWED', 'you already judged this entry');
      throw err;
    });
    const auditEntry = (outcome: string) => audit(tx, { actorId: me.userId, action: `challenge.judged.${outcome}`, targetKind: 'challenge_submission', targetId: id, metadata: { round: s.judging_round, decision: b.decision } });

    if (b.decision === 'escalate') {
      await auditEntry('escalated');
      return { state: 'pending_judging' as const, outcome: 'escalated' as const };
    }
    if (b.decision === 'disqualify') {
      // One judge's disqualification of a multi-judge entry goes to an admin.
      if (!settling && !admin && before.rubric.minJudges > 1) {
        await auditEntry('escalated');
        return { state: 'pending_judging' as const, outcome: 'escalated' as const };
      }
      await disqualify(tx, s, b.notes!, now);
      await auditEntry('disqualified');
      return { state: 'disqualified' as const, outcome: 'disqualified' as const };
    }
    const evidence = [...before.reviews.flatMap((r) => r.evidence as unknown[]), ...b.evidence];
    if (settling) {
      await applyScore(tx, s, score!, [...before.reviews.flatMap((r) => (r.reviewer_id ? [r.reviewer_id] : [])), me.userId], evidence, now);
      await auditEntry('approved');
      return { state: 'approved' as const, outcome: 'approved' as const };
    }
    const after = await roundState(tx, s);
    if (after.consolidation.status === 'need_more') return { state: 'pending_judging' as const, outcome: 'need_more' as const };
    if (after.consolidation.status === 'disagree') {
      await auditEntry('disagreement');
      return { state: 'pending_judging' as const, outcome: 'disagreement' as const };
    }
    await applyScore(tx, s, after.consolidation.result, after.reviews.flatMap((r) => (r.reviewer_id ? [r.reviewer_id] : [])), evidence, now);
    await auditEntry('approved');
    return { state: 'approved' as const, outcome: 'approved' as const };
  });
  await recordAgentRun(deps.db, agentLog(ctx.req.log), {
    agent: 'scoring', outcome: out.outcome === 'approved' ? 'ok' : 'routed_to_human', latencyMs: 0,
    subjectKind: 'challenge_submission', subjectId: id, detail: { route: 'human', decision: b.decision, result: out.outcome },
  });
  return out;
}

export const challengeJudgingRoutes = [
  route(
    { method: 'get', path: '/v1/judge/challenges/queue', summary: 'Entries waiting for your judgement, oldest first (blind)', tag: 'judging', auth: 'user', query: JudgeQueueQuery, response: JudgeQueueView },
    async (ctx) => {
      const me = ctx.me();
      const deps = ctx.deps;
      const staff = isStaff(me.roles);
      const admin = me.roles.includes('admin');
      const assigned = await assignedTo(deps.db, me.userId);
      if (!staff && !assigned.length) throw forbidden('FORBIDDEN', 'judges only');
      if (!me.mfa) throw forbidden('MFA_REQUIRED', 'judging requires MFA');
      let q = judgeQuery(deps.db).where('s.state', '=', 'pending_judging')
        // Conflict of interest: never your own or your child's entry.
        .where('s.user_id', 'not in', [me.userId, ...me.guardianOf]);
      if (!staff) q = q.where('s.challenge_id', 'in', assigned).where('v.visibility', '=', 'public').where('ps.profile_visibility', '=', 'public');
      if (ctx.query.challengeId) q = q.where('s.challenge_id', '=', ctx.query.challengeId);
      if (ctx.query.cursor) {
        const c = decodeCursor(ctx.query.cursor);
        q = q.where(sql<boolean>`(s.created_at, s.id) > (${c.at}, ${c.id}::uuid)`);
      }
      const items: z.input<typeof JudgeItemView>[] = [];
      let last: JudgeRow | undefined;
      let more = false;
      // Skip entries already judged by me this round, or waiting for an admin when I am not one.
      for (let page = 0; page < 5 && items.length < ctx.query.limit; page++) {
        if (last) q = q.where(sql<boolean>`(s.created_at, s.id) > (${last.created_at}, ${last.id}::uuid)`);
        const rows = await q.orderBy('s.created_at').orderBy('s.id').limit(ctx.query.limit * 2).execute();
        for (const r of rows) {
          last = r;
          if (!can(me, { kind: 'challenge.judge', assigned: assigned.includes(r.challenge_id), ownerId: r.user_id, clipPublic: !!r.clip_public }).allowed) continue;
          const item = await toItem(deps, me, r);
          const waitingForAdmin = item.flags.includes('disagreement');
          if ((waitingForAdmin && !admin) || (!waitingForAdmin && item.reviewedByMe)) continue;
          items.push(item);
          if (items.length >= ctx.query.limit) break;
        }
        more = rows.length === ctx.query.limit * 2;
        if (!more) break;
      }
      return { items, nextCursor: more && last ? encodeCursor(last.created_at, last.id) : null };
    },
  ),
  route(
    { method: 'get', path: '/v1/judge/challenge-submissions/:id', summary: 'One entry to judge (blind)', tag: 'judging', auth: 'user', response: JudgeItemView },
    async (ctx) => {
      const { id } = IdParam.parse(ctx.params);
      const s = await judgeQuery(ctx.deps.db).where('s.id', '=', id).executeTakeFirst();
      if (!s) throw notFound('entry');
      authorizeJudge(ctx, s, await assignedTo(ctx.deps.db, ctx.me().userId));
      return toItem(ctx.deps, ctx.me(), s);
    },
  ),
  route(
    { method: 'post', path: '/v1/judge/challenge-submissions/:id/reviews', summary: 'Score, disqualify or escalate an entry', tag: 'judging', auth: 'user', body: JudgeReviewRequest, response: JudgeReviewResult },
    async (ctx) => review(ctx),
  ),
];
