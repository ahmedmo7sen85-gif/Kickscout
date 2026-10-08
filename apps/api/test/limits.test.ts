import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresRateStore } from '../src/platform/rate-store.js';
import { createTestEnv } from './helpers.js';
import type { TestEnv } from './helpers.js';

const TRIGGER_SECRET = 't'.repeat(40);
const triggers: (string | undefined)[] = [];
const workerStub = createServer((req, res) => {
  triggers.push(req.headers.authorization);
  res.end('{}');
});

let env: TestEnv;
beforeAll(async () => {
  await new Promise<void>((r) => workerStub.listen(0, '127.0.0.1', r));
  const port = (workerStub.address() as AddressInfo).port;
  env = await createTestEnv({
    MAX_ACTIVE_VIDEOS: 2, MAX_UPLOADS_PER_DAY: 3, MAX_VIDEO_SECONDS: 45, RATE_LIMIT_STORE: 'postgres',
    WORKER_TRIGGER_URL: `http://127.0.0.1:${port}/api/worker`, WORKER_TRIGGER_SECRET: TRIGGER_SECRET,
  });
});
afterAll(async () => {
  workerStub.close();
  await env?.close();
});

async function call(method: string, url: string, token: string, body?: unknown) {
  const res = await env.app.inject({ method: method as 'POST', url, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

async function player(sub: string) {
  const token = await env.token(sub);
  const r = await call('POST', '/v1/onboarding/register', token, { handle: sub.replaceAll('-', '_'), displayName: sub, dob: '1995-04-02', countryCode: 'EG', roles: ['player'] });
  expect(r.status).toBe(201);
  return { token, userId: r.body.userId as string };
}

const start = (token: string) => call('POST', '/v1/uploads', token, { contentType: 'video/mp4', sizeBytes: 1000, title: 'Rabona' });

describe('upload quotas', () => {
  it('records the plan length limit on the video and caps live videos', async () => {
    const p = await player('quota-active');
    const a = await start(p.token);
    const b = await start(p.token);
    expect([a.status, b.status]).toEqual([201, 201]);
    const row = await env.db.selectFrom('videos').select('max_duration_ms').where('id', '=', a.body.videoId).executeTakeFirstOrThrow();
    expect(row.max_duration_ms).toBe(45_000);
    const c = await start(p.token);
    expect(c.status).toBe(403);
    expect(c.body.code).toBe('QUOTA_ACTIVE_VIDEOS');
    // Deleting one frees a slot.
    await env.db.updateTable('videos').set({ status: 'deleted', deleted_at: new Date() }).where('id', '=', a.body.videoId).execute();
    expect((await start(p.token)).status).toBe(201);
  });

  it('caps uploads started per day, counting deleted ones too', async () => {
    const p = await player('quota-daily');
    for (let i = 0; i < 3; i++) {
      const r = await start(p.token);
      expect(r.status).toBe(201);
      await env.db.updateTable('videos').set({ status: 'deleted', deleted_at: new Date() }).where('id', '=', r.body.videoId).execute();
    }
    const over = await start(p.token);
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('QUOTA_DAILY_UPLOADS');
    // Uploads older than a day no longer count.
    await env.db.updateTable('videos').set({ created_at: new Date(Date.now() - 25 * 3_600_000) }).where('owner_user_id', '=', p.userId).execute();
    expect((await start(p.token)).status).toBe(201);
  });

  it('wakes the worker with its secret once an upload completes', async () => {
    const p = await player('quota-wake');
    const r = await start(p.token);
    env.storage.objects.set(new URL(r.body.upload.url).pathname.slice(1), { sizeBytes: 1000, contentType: 'video/mp4' });
    const before = triggers.length;
    const done = await call('POST', `/v1/uploads/${r.body.videoId}/complete`, p.token);
    expect(done.status).toBe(200);
    expect(triggers.slice(before)).toEqual([`Bearer ${TRIGGER_SECRET}`]);
  });

  it('still completes the upload when the worker cannot be reached', async () => {
    env.deps.config.WORKER_TRIGGER_URL = 'http://127.0.0.1:1/api/worker';
    try {
      const p = await player('quota-wake-down');
      const r = await start(p.token);
      env.storage.objects.set(new URL(r.body.upload.url).pathname.slice(1), { sizeBytes: 1000, contentType: 'video/mp4' });
      const done = await call('POST', `/v1/uploads/${r.body.videoId}/complete`, p.token);
      expect(done.status).toBe(200);
      expect(done.body.status).toBe('processing');
    } finally {
      env.deps.config.WORKER_TRIGGER_URL = `http://127.0.0.1:${(workerStub.address() as AddressInfo).port}/api/worker`;
    }
  });
});

describe('postgres rate-limit store', () => {
  async function instance() {
    const app = Fastify();
    await app.register(rateLimit, { store: postgresRateStore(env.db), max: 3, timeWindow: '1 minute', keyGenerator: () => 'same-client' });
    app.get('/a', async () => 'ok');
    app.get('/b', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => 'ok');
    await app.ready();
    return app;
  }

  it('shares one limit across separate API instances, per route', async () => {
    const [one, two] = await Promise.all([instance(), instance()]);
    const codes = [];
    for (const app of [one, two, one, two]) codes.push((await app.inject({ url: '/a' })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    // A route with its own limit counts separately.
    expect((await one.inject({ url: '/b' })).statusCode).toBe(200);
    expect((await two.inject({ url: '/b' })).statusCode).toBe(429);
    await Promise.all([one.close(), two.close()]);
  });

  it('starts a fresh window once the old one has ended', async () => {
    const app = await instance();
    await env.db.updateTable('rate_limit_hits').set({ reset_at: new Date(Date.now() - 1000) }).execute();
    const r = await app.inject({ url: '/a' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-ratelimit-remaining']).toBe('2');
    await app.close();
  });

  it('lets requests through when the store fails, with skipOnError', async () => {
    const app = Fastify();
    const broken = { ...env.db, executeQuery: () => Promise.reject(new Error('db down')) } as unknown as typeof env.db;
    await app.register(rateLimit, { store: postgresRateStore(broken), skipOnError: true, max: 1, timeWindow: '1 minute' });
    app.get('/a', async () => 'ok');
    expect((await app.inject({ url: '/a' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/a' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('media URLs', () => {
  it('prefixes stored keys with the CDN and leaves absolute URLs alone', async () => {
    const { mediaUrl } = await import('../src/platform/storage.js');
    expect(mediaUrl('https://cdn.test', 'playback/x.mp4')).toBe('https://cdn.test/playback/x.mp4');
    expect(mediaUrl('https://cdn.test', 'https://web.test/demo-media/promo/01.mp4')).toBe('https://web.test/demo-media/promo/01.mp4');
  });
});
