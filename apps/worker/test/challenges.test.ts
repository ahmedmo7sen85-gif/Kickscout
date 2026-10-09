import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { DEFAULT_RUBRIC } from '@fp/domain';
import { runChallengeOperations, sendChallengeNotice, syncSubmissionForVideo } from '../src/challenges/index.js';
import { createTestDb, seedUser, silentLog } from './helpers.js';
import type { TestDb } from './helpers.js';

let tdb: TestDb;
beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb?.close();
});

const H = 3_600_000;
const at = (h: number) => new Date(Date.now() + h * H);

async function challenge(fields: { status: string; startsAt: Date; endsAt: Date; frozen?: boolean; minS?: number; maxS?: number }) {
  const db = tdb.db;
  const id = uuidv7();
  await db.insertInto('challenges').values({
    id, slug: `c-${id.slice(-12)}`, title: JSON.stringify({ en: 'Test', ar: 'تجربة' }), description: JSON.stringify({ en: 'Test', ar: 'تجربة' }),
    starts_at: fields.startsAt, ends_at: fields.endsAt, status: fields.status, min_duration_s: fields.minS ?? 3, max_duration_s: fields.maxS ?? 60, skill_key: 'juggling',
  }).execute();
  const rubricId = uuidv7();
  await db.insertInto('challenge_rubric_versions').values({ id: rubricId, challenge_id: id, version: 1, method: 'judged', rubric: JSON.stringify(DEFAULT_RUBRIC), frozen_at: fields.frozen ? new Date() : null }).execute();
  await db.updateTable('challenges').set({ rubric_version_id: rubricId }).where('id', '=', id).execute();
  return { id, rubricId };
}

async function entry(c: { id: string; rubricId: string }, owner: string, video: { status: string; durationMs?: number; sha256?: Buffer; createdAt?: Date }) {
  const db = tdb.db;
  const videoId = uuidv7();
  await db.insertInto('videos').values({
    id: videoId, owner_user_id: owner, original_key: `originals/${owner}/${videoId}.mp4`, declared_type: 'video/mp4', size_bytes: 1, title: 't',
    status: 'processing', duration_ms: video.durationMs ?? 20_000, sha256: video.sha256 ?? null, created_at: video.createdAt ?? new Date(),
  }).execute();
  const pid = uuidv7();
  await db.insertInto('challenge_participations').values({ id: pid, challenge_id: c.id, user_id: owner }).onConflict((oc) => oc.columns(['challenge_id', 'user_id']).doNothing()).execute();
  const p = await db.selectFrom('challenge_participations').select('id').where('challenge_id', '=', c.id).where('user_id', '=', owner).executeTakeFirstOrThrow();
  const n = await db.selectFrom('challenge_submissions').select((eb) => eb.fn.countAll<string>().as('n')).where('participation_id', '=', p.id).executeTakeFirstOrThrow();
  const id = uuidv7();
  await db.insertInto('challenge_submissions').values({ id, challenge_id: c.id, participation_id: p.id, user_id: owner, video_id: videoId, attempt_no: Number(n.n) + 1, state: 'processing', rubric_version_id: c.rubricId }).execute();
  if (video.status !== 'processing') {
    await db.updateTable('videos').set({ status: video.status, published_at: video.status === 'published' ? new Date() : null }).where('id', '=', videoId).execute();
  }
  return { id, videoId };
}

const state = async (id: string) => (await tdb.db.selectFrom('challenge_submissions').select(['state', 'state_reason']).where('id', '=', id).executeTakeFirstOrThrow());

describe('challenge entries follow their video', () => {
  it('queues a sync job whenever an entry’s video changes status', async () => {
    const c = await challenge({ status: 'active', startsAt: at(-1), endsAt: at(24), frozen: true });
    const owner = await seedUser(tdb.db);
    const e = await entry(c, owner, { status: 'published' });
    const jobs = await tdb.db.selectFrom('jobs').select('payload').where('kind', '=', 'challenge.sync').execute();
    expect(jobs.map((j) => (j.payload as { videoId: string }).videoId)).toContain(e.videoId);
  });

  it('verifies a published clip, then waits for judges; never earlier', async () => {
    const c = await challenge({ status: 'active', startsAt: at(-1), endsAt: at(24), frozen: true });
    const owner = await seedUser(tdb.db);
    const e = await entry(c, owner, { status: 'processing' });
    await tdb.db.updateTable('videos').set({ status: 'review_required' }).where('id', '=', e.videoId).execute();
    expect(await syncSubmissionForVideo(tdb.db, e.videoId)).toMatchObject({ to: 'pending_moderation' });
    // The database refuses to put an unpublished clip in front of judges.
    await expect(tdb.db.updateTable('challenge_submissions').set({ state: 'pending_judging' }).where('id', '=', e.id).execute()).rejects.toThrow(/cannot be pending_judging/);
    await tdb.db.updateTable('videos').set({ status: 'published', published_at: new Date() }).where('id', '=', e.videoId).execute();
    expect(await syncSubmissionForVideo(tdb.db, e.videoId)).toMatchObject({ to: 'pending_judging' });
    expect(await syncSubmissionForVideo(tdb.db, e.videoId)).toEqual({ skipped: 'already past moderation' });
    const runs = await tdb.db.selectFrom('challenge_agent_runs').select(['agent', 'outcome', 'agent_version', 'trace_id', 'latency_ms']).where('subject_id', '=', e.id).orderBy('id').execute();
    expect(runs.map((r) => [r.agent, r.outcome])).toEqual([['verification', 'ok'], ['scoring', 'routed_to_human']]);
    expect(runs.every((r) => r.agent_version && r.trace_id.length >= 8 && r.latency_ms >= 0)).toBe(true);
    const notices = await tdb.db.selectFrom('notifications').select('kind').where('user_id', '=', owner).execute();
    expect(notices.map((n) => n.kind)).toEqual(['challenge.submission_received']);
  });

  it('rejects a clip that is too long or another entrant’s file, and says why', async () => {
    const c = await challenge({ status: 'active', startsAt: at(-1), endsAt: at(24), frozen: true, maxS: 30 });
    const a = await seedUser(tdb.db);
    const b = await seedUser(tdb.db);
    const long = await entry(c, a, { status: 'published', durationMs: 45_000 });
    expect(await syncSubmissionForVideo(tdb.db, long.videoId)).toMatchObject({ to: 'rejected' });
    expect((await state(long.id)).state_reason).toMatch(/between 3 and 30 seconds/);
    const hash = Buffer.alloc(32, 7);
    await entry(c, a, { status: 'processing', sha256: hash });
    const copy = await entry(c, b, { status: 'published', sha256: hash });
    expect(await syncSubmissionForVideo(tdb.db, copy.videoId)).toMatchObject({ to: 'rejected' });
    expect((await state(copy.id)).state_reason).toMatch(/another player/);
  });

  it('withdraws an entry when its clip is deleted, and keeps it withdrawn', async () => {
    const c = await challenge({ status: 'active', startsAt: at(-1), endsAt: at(24), frozen: true });
    const owner = await seedUser(tdb.db);
    const e = await entry(c, owner, { status: 'published' });
    await syncSubmissionForVideo(tdb.db, e.videoId);
    await tdb.db.updateTable('videos').set({ status: 'deleted' }).where('id', '=', e.videoId).execute();
    expect(await syncSubmissionForVideo(tdb.db, e.videoId)).toMatchObject({ to: 'withdrawn' });
    await expect(tdb.db.updateTable('challenge_submissions').set({ state: 'pending_judging' }).where('id', '=', e.id).execute()).rejects.toThrow(/withdrawn/);
  });
});

describe('challenge notices', () => {
  it('sends each notice once, and caps optional reminders per day', async () => {
    const u = await seedUser(tdb.db);
    const n = (kind: 'challenge.result' | 'challenge.ending_soon', k: string) => sendChallengeNotice(tdb.db, { userId: u, kind, dedupeKey: k, payload: {} });
    expect(await n('challenge.result', 'r:1')).toBe('sent');
    expect(await Promise.all([n('challenge.result', 'r:2'), n('challenge.result', 'r:2'), n('challenge.result', 'r:2')])).toEqual(expect.arrayContaining(['sent', 'duplicate', 'duplicate']));
    expect([await n('challenge.ending_soon', 'e:1'), await n('challenge.ending_soon', 'e:2'), await n('challenge.ending_soon', 'e:3')]).toEqual(['sent', 'sent', 'suppressed']);
    // Essential notices are never capped.
    expect(await n('challenge.result', 'r:3')).toBe('sent');
    const sent = await tdb.db.selectFrom('notifications').select('kind').where('user_id', '=', u).execute();
    expect(sent).toHaveLength(5);
  });
});

describe('Challenge Operations Agent', () => {
  it('opens, closes and completes challenges on schedule, freezing rubrics, and is idempotent', async () => {
    const opening = await challenge({ status: 'scheduled', startsAt: at(-1), endsAt: at(24) });
    const closing = await challenge({ status: 'active', startsAt: at(-48), endsAt: at(-1), frozen: true });
    const done = await challenge({ status: 'judging', startsAt: at(-72), endsAt: at(-3), frozen: true });
    const waiting = await challenge({ status: 'judging', startsAt: at(-72), endsAt: at(-3), frozen: true });
    const owner = await seedUser(tdb.db);
    const pending = await entry(waiting, owner, { status: 'published', createdAt: at(-10) });
    await syncSubmissionForVideo(tdb.db, pending.videoId);

    const r = await runChallengeOperations(tdb.db, silentLog);
    const status = async (id: string) => (await tdb.db.selectFrom('challenges').select(['status', 'results_published_at']).where('id', '=', id).executeTakeFirstOrThrow());
    expect((await status(opening.id)).status).toBe('active');
    expect((await status(closing.id)).status).toBe('judging');
    expect(await status(done.id)).toMatchObject({ status: 'completed', results_published_at: expect.any(Date) });
    // An entry still waiting for judges holds the results back.
    expect((await status(waiting.id)).status).toBe('judging');
    const frozen = await tdb.db.selectFrom('challenge_rubric_versions').select('frozen_at').where('id', '=', opening.rubricId).executeTakeFirstOrThrow();
    expect(frozen.frozen_at).toBeInstanceOf(Date);
    expect(r.transitioned).toBeGreaterThanOrEqual(2);
    expect(r.resultsPublished).toBeGreaterThanOrEqual(1);

    const again = await runChallengeOperations(tdb.db, silentLog);
    expect(again).toMatchObject({ transitioned: 0, resultsPublished: 0, rubricsFrozen: 0 });
    const ops = await tdb.db.selectFrom('challenge_agent_runs').select('agent').where('agent', 'in', ['operations', 'notification', 'anti_fraud']).execute();
    expect(new Set(ops.map((o) => o.agent))).toEqual(new Set(['operations', 'notification', 'anti_fraud']));
  });

  it('reminds joined players with nothing entered once before the deadline', async () => {
    const c = await challenge({ status: 'active', startsAt: at(-24), endsAt: at(6), frozen: true });
    const idle = await seedUser(tdb.db);
    await tdb.db.insertInto('challenge_participations').values({ id: uuidv7(), challenge_id: c.id, user_id: idle }).execute();
    await runChallengeOperations(tdb.db, silentLog);
    await runChallengeOperations(tdb.db, silentLog);
    const n = await tdb.db.selectFrom('notifications').select('kind').where('user_id', '=', idle).execute();
    expect(n.map((x) => x.kind)).toEqual(['challenge.ending_soon']);
  });

  it('sets aside a burst of votes from young accounts', async () => {
    const c = await challenge({ status: 'active', startsAt: at(-24), endsAt: at(24), frozen: true });
    const owner = await seedUser(tdb.db);
    const e = await entry(c, owner, { status: 'published' });
    const voters = await Promise.all(Array.from({ length: 10 }, () => seedUser(tdb.db)));
    await tdb.db.insertInto('challenge_votes').values(voters.map((v) => ({ challenge_id: c.id, submission_id: e.id, voter_id: v }))).execute();
    const r = await runChallengeOperations(tdb.db, silentLog);
    expect(r.votesSetAside).toBe(10);
    const left = await tdb.db.selectFrom('challenge_votes').select(['eligible', 'flag_reason']).where('submission_id', '=', e.id).execute();
    expect(left.every((v) => !v.eligible && v.flag_reason === 'burst')).toBe(true);
  });
});
