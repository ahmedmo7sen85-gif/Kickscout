import { rm } from 'node:fs/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '@fp/db';
import { backoffMs, claimJob, enqueue, recoverStaleJobs } from '../src/queue.js';
import { FakeAnalyzer, SAFE, createEnv, createTestDb, getJob, getVideo, makeClips, notificationsFor, seedUser, seedVideo } from './helpers.js';
import type { Clips, Env, TestDb } from './helpers.js';

let tdb: TestDb;
let env: Env;
let clips: Clips;

beforeAll(async () => {
  [tdb, clips] = await Promise.all([createTestDb(), makeClips()]);
  env = await createEnv(tdb.db);
});

afterAll(async () => {
  await env?.close();
  await tdb?.close();
  if (clips) await rm(clips.dir, { recursive: true, force: true });
});

// Each test starts from an empty queue so jobs never leak between tests.
beforeEach(async () => {
  await tdb.db.deleteFrom('jobs').execute();
});

describe('job queue', () => {
  it('two workers claiming concurrently never take the same job', async () => {
    const ids = [];
    for (let i = 0; i < 40; i++) ids.push(await enqueue(tdb.db, 'test.noop', { i }));
    // separate pools, as separate worker processes would have
    const a = createDb(tdb.url, 4);
    const b = createDb(tdb.url, 4);
    try {
      const drainWith = async (db: typeof a) => {
        const got: string[] = [];
        const lanes = Array.from({ length: 4 }, async () => {
          for (;;) {
            const job = await claimJob(db);
            if (!job) return;
            got.push(job.id);
          }
        });
        await Promise.all(lanes);
        return got;
      };
      const [fromA, fromB] = await Promise.all([drainWith(a), drainWith(b)]);
      const all = [...fromA, ...fromB];
      expect(all).toHaveLength(40);
      expect(new Set(all).size).toBe(40);
      expect(new Set(all)).toEqual(new Set(ids));
      expect(fromA.length).toBeGreaterThan(0);
      expect(fromB.length).toBeGreaterThan(0);
      const rows = await tdb.db.selectFrom('jobs').select(['status', 'attempts']).execute();
      expect(rows.every((r) => r.status === 'running' && r.attempts === 1)).toBe(true);
    } finally {
      await a.destroy();
      await b.destroy();
    }
  });

  it('does not claim jobs whose run_after is in the future', async () => {
    const id = await enqueue(tdb.db, 'test.noop', {});
    await tdb.db.updateTable('jobs').set({ run_after: sql`now() + interval '1 hour'` }).where('id', '=', id).execute();
    expect(await claimJob(tdb.db)).toBeNull();
  });

  it('backs off exponentially', () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, 1000))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffMs(30, 1000)).toBe(3_600_000);
  });

  it('retries a throwing analyzer with backoff, then fails the video and notifies the owner', async () => {
    const owner = await seedUser(tdb.db);
    const { videoId, jobId } = await seedVideo(env, { owner, clip: clips.valid }, 3);
    const analyzer = new FakeAnalyzer(() => {
      throw new Error('AI service overloaded');
    });
    const worker = env.worker(analyzer, { retryBaseMs: 1_000 });
    const delays: number[] = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await worker.runOnce()).toBe(true);
      const job = await getJob(tdb.db, jobId);
      expect(job.attempts).toBe(attempt);
      expect(job.last_error).toContain('AI service overloaded');
      if (attempt < 3) {
        expect(job.status).toBe('queued');
        const { rows } = await sql<{ ms: number }>`SELECT (extract(epoch FROM run_after - now()) * 1000)::float8 AS ms FROM jobs WHERE id = ${jobId}`.execute(tdb.db);
        delays.push(rows[0]!.ms);
        expect(await worker.runOnce()).toBe(false); // not ready yet
        expect((await getVideo(tdb.db, videoId)).status).toBe('analyzing');
        await tdb.db.updateTable('jobs').set({ run_after: sql`now()` }).where('id', '=', jobId).execute();
      } else {
        expect(job.status).toBe('failed');
        expect(job.finished_at).toBeInstanceOf(Date);
      }
    }
    expect(analyzer.calls).toHaveLength(3);
    // ~1 s after the first failure, ~2 s after the second
    expect(delays[0]).toBeGreaterThan(500);
    expect(delays[0]).toBeLessThanOrEqual(1_000);
    expect(delays[1]).toBeGreaterThan(1_500);
    expect(delays[1]).toBeLessThanOrEqual(2_000);

    const v = await getVideo(tdb.db, videoId);
    expect(v.status).toBe('failed');
    expect(v.status_reason).toMatch(/could not process/);
    expect((await notificationsFor(tdb.db, owner)).map((n) => n.kind)).toEqual(['video.failed']);
  });

  it('fails a job at once on a permanent error (missing original)', async () => {
    const owner = await seedUser(tdb.db);
    const { videoId, jobId } = await seedVideo(env, { owner, clip: clips.valid });
    const v = await getVideo(tdb.db, videoId);
    await rm(env.storage.originalPath(v.original_key));
    await env.worker(FakeAnalyzer.returning(SAFE)).runOnce();
    const job = await getJob(tdb.db, jobId);
    expect(job).toMatchObject({ status: 'failed', attempts: 1 });
    expect(job.last_error).toMatch(/not found/);
    expect((await getVideo(tdb.db, videoId)).status).toBe('failed');
  });

  it('re-queues jobs stuck in running past the timeout, and fails those out of attempts', async () => {
    const owner = await seedUser(tdb.db);
    const stuck = await seedVideo(env, { owner, clip: clips.valid }, 3);
    const exhausted = await seedVideo(env, { owner, clip: clips.valid }, 1);
    const fresh = await enqueue(tdb.db, 'test.noop', {});
    await tdb.db.updateTable('jobs').set({ status: 'running', attempts: 1, locked_at: sql`now() - interval '20 minutes'` }).where('id', 'in', [stuck.jobId, exhausted.jobId]).execute();
    await tdb.db.updateTable('jobs').set({ status: 'running', attempts: 1, locked_at: sql`now() - interval '1 minute'` }).where('id', '=', fresh).execute();

    const worker = env.worker(FakeAnalyzer.returning(SAFE), { jobTimeoutMs: 15 * 60_000 });
    await worker.recoverStale();

    expect(await getJob(tdb.db, stuck.jobId)).toMatchObject({ status: 'queued', locked_at: null });
    expect(await getJob(tdb.db, exhausted.jobId)).toMatchObject({ status: 'failed' });
    expect(await getJob(tdb.db, fresh)).toMatchObject({ status: 'running' });
    expect((await getVideo(tdb.db, exhausted.videoId)).status).toBe('failed');

    // the re-queued one then completes normally
    expect(await worker.runOnce()).toBe(true);
    expect((await getVideo(tdb.db, stuck.videoId)).status).toBe('published');
    expect(await recoverStaleJobs(tdb.db, 15 * 60_000)).toEqual({ requeued: 0, failed: [] });
  });

  it('fails unknown job kinds without retrying', async () => {
    const id = await enqueue(tdb.db, 'nope.unknown', {});
    await env.worker(null).runOnce();
    expect(await getJob(tdb.db, id)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('runs with concurrency and stops gracefully, finishing jobs in flight', async () => {
    const owner = await seedUser(tdb.db);
    const seeded = [];
    for (let i = 0; i < 3; i++) seeded.push(await seedVideo(env, { owner, clip: clips.valid }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const analyzer = new FakeAnalyzer(async () => {
      started++;
      await gate;
      return { kind: 'result', analysis: SAFE, model: 'fake-model' };
    });
    const worker = env.worker(analyzer, { concurrency: 3, pollIntervalMs: 20 });
    worker.start();
    while (started < 3) await new Promise((r) => setTimeout(r, 25));
    const stopping = worker.stop();
    release();
    await stopping;
    for (const s of seeded) {
      expect((await getVideo(tdb.db, s.videoId)).status).toBe('published');
      expect((await getJob(tdb.db, s.jobId)).status).toBe('done');
    }
  });
});
