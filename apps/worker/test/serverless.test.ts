import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import handler, { runBatch } from '../src/serverless.js';
import { FakeAnalyzer, SAFE, createEnv, createTestDb, getVideo, makeClips, seedUser, seedVideo } from './helpers.js';
import type { Clips, Env, TestDb } from './helpers.js';
import { rm } from 'node:fs/promises';

let tdb: TestDb;
let env: Env;
let clips: Clips;
let base: string;
const server = createServer((req, res) => void handler(req, res));
const SECRET = 'w'.repeat(40);

beforeAll(async () => {
  [tdb, clips] = await Promise.all([createTestDb(), makeClips()]);
  env = await createEnv(tdb.db);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await env?.close();
  await tdb?.close();
  if (clips) await rm(clips.dir, { recursive: true, force: true });
  delete process.env.WORKER_TRIGGER_SECRET;
});

describe('serverless worker entry', () => {
  it('is closed when no trigger secret is configured', async () => {
    delete process.env.WORKER_TRIGGER_SECRET;
    delete process.env.CRON_SECRET;
    const res = await fetch(`${base}/api/worker`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(503);
  });

  it('rejects a missing or wrong bearer token before touching anything', async () => {
    process.env.WORKER_TRIGGER_SECRET = SECRET;
    expect((await fetch(`${base}/api/worker`, { method: 'POST' })).status).toBe(401);
    const wrong = await fetch(`${base}/api/worker`, { method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(40)}` } });
    expect(wrong.status).toBe(401);
    const short = await fetch(`${base}/api/worker`, { method: 'POST', headers: { authorization: 'Bearer w' } });
    expect(short.status).toBe(401);
  });

  it('runBatch processes every queued job, then stops when the queue is empty', async () => {
    const owner = await seedUser(env.db);
    const a = await seedVideo(env, { owner, clip: clips.valid });
    const b = await seedVideo(env, { owner, clip: clips.vertical });
    const jobs = await runBatch(env.worker(FakeAnalyzer.returning(SAFE)), { claimBudgetMs: 60_000 });
    expect(jobs).toBe(2);
    expect((await getVideo(env.db, a.videoId)).status).toBe('published');
    expect((await getVideo(env.db, b.videoId)).status).toBe('published');
  });

  it('runBatch claims nothing once the budget is spent', async () => {
    const owner = await seedUser(env.db);
    const { videoId } = await seedVideo(env, { owner, clip: clips.valid });
    expect(await runBatch(env.worker(null), { claimBudgetMs: 0 })).toBe(0);
    expect((await getVideo(env.db, videoId)).status).toBe('processing');
  });
});
