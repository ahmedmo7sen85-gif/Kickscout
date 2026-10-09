/**
 * Entering a challenge: joining, then submitting a new clip (or one recorded during the window).
 * A submission is an ordinary upload, so it goes through the mandatory video safety pipeline; the
 * entry follows its video from there (see apps/worker/src/challenges/sync.ts).
 *
 * Every check runs twice: once up front to fail fast, and again inside the transaction with the
 * participation row locked, so two parallel requests cannot exceed the attempt limit.
 */
import type { Transaction } from 'kysely';
import type { DB } from '@fp/db';
import type { Actor, AgeBand, ChallengeDifficulty } from '@fp/domain';
import { checkEligibility, needsSafetyAck } from '@fp/domain';
import type { Ctx } from '../platform/route.js';
import type { Deps } from '../deps.js';
import { ApiError, conflict, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { audit } from '../platform/events.js';
import { beginUpload, replaceHashtags, wakeWorker } from './media.js';
import type { UploadFields } from './media.js';
import { attemptsUsed, entryHashtags, loadChallenge, phaseOf } from './challenge-views.js';
import type { ChallengeRow } from './challenge-views.js';

export interface EntryFlags {
  idempotencyKey?: string | undefined;
  claimedValue?: number | undefined;
  othersInClip: boolean;
  consentOthers: boolean;
  safetyAck: boolean;
  targetSubmissionId?: string | undefined;
  ref?: string | undefined;
}

type Db = Deps['db'] | Transaction<DB>;

/** Who shared the invite link, if it is a real active player other than the entrant. */
async function inviter(db: Db, handle: string | undefined, me: string): Promise<string | null> {
  if (!handle) return null;
  const r = await db.selectFrom('profiles').innerJoin('users', 'users.id', 'profiles.user_id').select('users.id')
    .where('profiles.handle', '=', handle).where('users.status', '=', 'active').executeTakeFirst();
  return r && r.id !== me ? r.id : null;
}

/** Joins (idempotently) and locks the participation row for the rest of the transaction. */
export async function lockParticipation(tx: Transaction<DB>, challengeId: string, userId: string, opts: { ref?: string | undefined; safetyAck?: boolean; now: Date }) {
  const invitedBy = await inviter(tx, opts.ref, userId);
  await tx.insertInto('challenge_participations').values({
    id: newId(), challenge_id: challengeId, user_id: userId, invited_by: invitedBy, safety_ack_at: opts.safetyAck ? opts.now : null,
  }).onConflict((oc) => oc.columns(['challenge_id', 'user_id']).doNothing()).execute();
  const p = await tx.selectFrom('challenge_participations').selectAll().where('challenge_id', '=', challengeId).where('user_id', '=', userId).forUpdate().executeTakeFirstOrThrow();
  if (opts.safetyAck && !p.safety_ack_at) await tx.updateTable('challenge_participations').set({ safety_ack_at: opts.now }).where('id', '=', p.id).execute();
  return p;
}

function assertEligible(me: Actor, c: ChallengeRow, now: Date, participation: { status: string } | null, used: number, f: EntryFlags) {
  const r = checkEligibility({
    actor: me,
    challenge: {
      phase: phaseOf(c, now), ageGroups: c.age_groups as AgeBand[], difficulty: c.difficulty as ChallengeDifficulty,
      hasSafetyNotes: c.safety_notes !== null, requiresPartner: c.requires_partner, attemptLimit: c.attempt_limit,
    },
    participation: participation as never, attemptsUsed: used, othersInClip: f.othersInClip, consentOthers: f.consentOthers, safetyAck: f.safetyAck,
  });
  if (!r.allowed) throw new ApiError(r.code === 'CHALLENGE_NOT_OPEN' ? 400 : 403, r.code, r.reason);
}

/** Beat My Skill: the entry answered must be approved, public, in the same challenge and someone else's. */
async function checkTarget(db: Db, c: ChallengeRow, me: string, targetId: string | undefined) {
  if (!targetId) {
    if (c.format === 'beat_my_skill') throw new ApiError(400, 'TARGET_REQUIRED', 'pick the entry you are answering');
    return null;
  }
  if (c.format !== 'beat_my_skill') throw new ApiError(400, 'TARGET_NOT_ALLOWED', 'this challenge does not answer other entries');
  const t = await db.selectFrom('challenge_submissions as s').innerJoin('videos as v', 'v.id', 's.video_id')
    .innerJoin('privacy_settings as ps', 'ps.user_id', 's.user_id')
    .select(['s.id', 's.user_id']).where('s.id', '=', targetId).where('s.challenge_id', '=', c.id).where('s.state', '=', 'approved')
    .where('v.status', '=', 'published').where('v.visibility', '=', 'public').where('ps.profile_visibility', '=', 'public').executeTakeFirst();
  if (!t) throw notFound('entry');
  if (t.user_id === me) throw new ApiError(400, 'OWN_ENTRY', 'answer someone else’s entry');
  return t.id;
}

async function existingByKey(deps: Deps, userId: string, key: string | undefined) {
  if (!key) return null;
  return deps.db.selectFrom('challenge_submissions as s').innerJoin('videos as v', 'v.id', 's.video_id')
    .select(['s.id', 's.video_id', 's.state', 's.challenge_id', 'v.original_key', 'v.declared_type', 'v.size_bytes'])
    .where('s.user_id', '=', userId).where('s.idempotency_key', '=', key).executeTakeFirst();
}

async function insertSubmission(tx: Transaction<DB>, deps: Deps, me: Actor, c: ChallengeRow, f: EntryFlags, videoId: string, state: 'pending_upload' | 'processing' | 'pending_moderation') {
  const now = deps.now();
  const p = await lockParticipation(tx, c.id, me.userId, { ref: f.ref, safetyAck: f.safetyAck, now });
  const used = await attemptsUsed(tx as never, p.id, c.retry_failed);
  assertEligible(me, c, now, p, used, { ...f, safetyAck: f.safetyAck || p.safety_ack_at !== null });
  const target = await checkTarget(tx, c, me.userId, f.targetSubmissionId);
  const last = await tx.selectFrom('challenge_submissions').select((eb) => eb.fn.max('attempt_no').as('n')).where('participation_id', '=', p.id).executeTakeFirst();
  const id = newId();
  await tx.insertInto('challenge_submissions').values({
    id, challenge_id: c.id, participation_id: p.id, user_id: me.userId, video_id: videoId, attempt_no: Number(last?.n ?? 0) + 1,
    state, rubric_version_id: c.rubric_version_id!, claimed_value: f.claimedValue ?? null,
    consent_others_at: f.othersInClip || c.requires_partner ? now : null, safety_ack_at: f.safetyAck ? now : null,
    target_submission_id: target, idempotency_key: f.idempotencyKey ?? null,
  }).execute();
  // Older readers (Discover counts, entry lists) still see the pair.
  await tx.insertInto('challenge_entries').values({ challenge_id: c.id, video_id: videoId }).onConflict((oc) => oc.columns(['challenge_id', 'video_id']).doNothing()).execute();
  await audit(tx, { actorId: me.userId, action: 'challenge.submitted', targetKind: 'challenge_submission', targetId: id, metadata: { challengeId: c.id, videoId, attempt: Number(last?.n ?? 0) + 1 } });
  return id;
}

/** Fast pre-check before signing an upload URL (repeated authoritatively in the transaction). */
async function precheck(deps: Deps, me: Actor, c: ChallengeRow, f: EntryFlags) {
  if (!c.rubric_version_id) throw new ApiError(400, 'CHALLENGE_NOT_OPEN', 'this challenge is not open');
  const p = await deps.db.selectFrom('challenge_participations').select(['id', 'status', 'safety_ack_at']).where('challenge_id', '=', c.id).where('user_id', '=', me.userId).executeTakeFirst();
  const acked = f.safetyAck || (p?.safety_ack_at ?? null) !== null;
  assertEligible(me, c, deps.now(), p ?? null, p ? await attemptsUsed(deps.db, p.id, c.retry_failed) : 0, { ...f, safetyAck: acked });
  await checkTarget(deps.db, c, me.userId, f.targetSubmissionId);
}

export interface SubmissionResult {
  submissionId: string;
  videoId: string;
  state: string;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string } | null;
}

/** POST /v1/challenges/:slug/submissions (and /v1/uploads with a challengeId). Idempotent by key. */
export async function submitToChallenge(ctx: Ctx<unknown, unknown>, slugOrId: string, b: UploadFields & EntryFlags): Promise<SubmissionResult> {
  ctx.authorize({ kind: 'video.upload' });
  const me = ctx.me();
  const deps = ctx.deps;
  const prior = await existingByKey(deps, me.userId, b.idempotencyKey);
  if (prior) {
    // A resend (lost response, retry): same entry, and a fresh URL while the file has not arrived.
    if (prior.state !== 'pending_upload') return { submissionId: prior.id, videoId: prior.video_id, state: prior.state, upload: null };
    const u = await deps.storage.presignPut(prior.original_key, prior.declared_type, Number(prior.size_bytes));
    return { submissionId: prior.id, videoId: prior.video_id, state: prior.state, upload: { url: u.url, method: 'PUT', headers: u.headers, expiresAt: u.expiresAt.toISOString() } };
  }
  const c = await loadChallenge(deps, slugOrId).catch(() => {
    throw new ApiError(400, 'CHALLENGE_NOT_OPEN', 'this challenge is not open');
  });
  await precheck(deps, me, c, b);
  let submissionId = '';
  const { videoId, upload } = await beginUpload(deps, me, { ...b, hashtags: entryHashtags(b.hashtags, c.hashtag) }, {
    context: 'challenge',
    maxDurationMs: c.max_duration_s * 1000,
    inTx: async (tx, vid) => {
      submissionId = await insertSubmission(tx, deps, me, c, b, vid, 'pending_upload');
    },
  }).catch(async (err: { code?: string; constraint?: string }) => {
    // Two parallel requests with the same key: the loser returns the winner's entry.
    if (err.code === '23505' && err.constraint === 'challenge_submissions_idem_idx') {
      const won = await existingByKey(deps, me.userId, b.idempotencyKey);
      if (won) return { videoId: won.video_id, upload: null, key: '' };
    }
    throw err;
  });
  if (!upload) {
    const won = (await existingByKey(deps, me.userId, b.idempotencyKey))!;
    return { submissionId: won.id, videoId: won.video_id, state: won.state, upload: null };
  }
  await ctx.track('upload_started', { videoId, challenge: true });
  await ctx.track('challenge_submitted', { challengeId: c.id, submissionId });
  return { submissionId, videoId, state: 'pending_upload', upload };
}

/** POST /v1/challenges/:slug/entries: enter a clip already uploaded during the challenge window. */
export async function enterExistingVideo(ctx: Ctx<unknown, unknown>, slug: string, b: EntryFlags & { videoId: string }) {
  const me = ctx.me();
  const deps = ctx.deps;
  const c = await loadChallenge(deps, slug);
  const prior = await existingByKey(deps, me.userId, b.idempotencyKey);
  if (prior) return prior.id;
  const v = await deps.db.selectFrom('videos').select(['id', 'owner_user_id', 'status', 'created_at']).where('id', '=', b.videoId).where('status', '!=', 'deleted').executeTakeFirst();
  if (!v) throw notFound('video');
  ctx.authorize({ kind: 'challenge.enter', videoOwnerId: v.owner_user_id });
  if (v.owner_user_id !== me.userId) throw new ApiError(403, 'FORBIDDEN', 'only the uploader can enter a clip');
  const taken = await deps.db.selectFrom('challenge_submissions').select('id').where('video_id', '=', v.id).executeTakeFirst();
  if (taken) throw conflict('ALREADY_ENTERED', 'this video is already entered');
  // Fairness: only clips recorded for this challenge (uploaded while it is open) can enter.
  if (v.created_at < c.starts_at) throw new ApiError(400, 'RECORDED_BEFORE_START', 'enter a clip uploaded after the challenge started');
  await precheck(deps, me, c, b);
  const state = v.status === 'uploading' ? 'pending_upload' : v.status === 'processing' || v.status === 'analyzing' ? 'processing' : 'pending_moderation';
  const id = await deps.db.transaction().execute(async (tx) => {
    const sid = await insertSubmission(tx, deps, me, c, b, v.id, state);
    const tags = await tx.selectFrom('video_hashtags').select('tag').where('video_id', '=', v.id).execute();
    await replaceHashtags(tx, v.id, entryHashtags(tags.map((t) => t.tag), c.hashtag));
    // A published clip moves to verification and judging through the same sync job as a new upload.
    if (v.status === 'published' || v.status === 'rejected' || v.status === 'failed') {
      await tx.insertInto('jobs').values({ kind: 'challenge.sync', payload: JSON.stringify({ videoId: v.id }) }).execute();
    }
    return sid;
  }).catch(async (err: { code?: string; constraint?: string }) => {
    if (err.code === '23505') throw conflict('ALREADY_ENTERED', 'this video is already entered');
    throw err;
  });
  await wakeWorker(deps, ctx.req.log);
  await ctx.track('challenge_submitted', { challengeId: c.id, submissionId: id });
  return id;
}

/** POST /v1/challenges/:slug/join */
export async function joinChallenge(ctx: Ctx<unknown, unknown>, slug: string, b: { ref?: string | undefined; safetyAck: boolean }) {
  ctx.authorize({ kind: 'video.upload' });
  const me = ctx.me();
  const c = await loadChallenge(ctx.deps, slug);
  const phase = phaseOf(c, ctx.deps.now());
  if (phase !== 'open' && phase !== 'upcoming') throw new ApiError(400, 'CHALLENGE_NOT_OPEN', 'this challenge is not open');
  if (!(c.age_groups as AgeBand[]).includes(me.ageBand)) throw new ApiError(403, 'AGE_GROUP_NOT_ELIGIBLE', 'this challenge is for another age group');
  if (needsSafetyAck({ difficulty: c.difficulty as ChallengeDifficulty, hasSafetyNotes: c.safety_notes !== null }) && !b.safetyAck) {
    throw new ApiError(403, 'SAFETY_ACK_REQUIRED', 'read and accept the safety notes first');
  }
  const created = await ctx.deps.db.transaction().execute(async (tx) => {
    const before = await tx.selectFrom('challenge_participations').select('id').where('challenge_id', '=', c.id).where('user_id', '=', me.userId).executeTakeFirst();
    const p = await lockParticipation(tx, c.id, me.userId, { ref: b.ref, safetyAck: b.safetyAck, now: ctx.deps.now() });
    if (p.status !== 'active') throw new ApiError(403, 'PARTICIPATION_CLOSED', `your participation is ${p.status}`);
    return { isNew: !before, invited: p.invited_by !== null };
  });
  if (created.isNew) await ctx.track('challenge_joined', { challengeId: c.id, invited: created.invited });
  return c;
}
