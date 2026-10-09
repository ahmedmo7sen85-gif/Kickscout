import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { runMaintenance, DEFAULT_MAINTENANCE } from '../src/maintenance.js';
import { playbackKey, thumbnailKey } from '../src/storage/storage.js';
import { createEnv, createTestDb, getVideo, seedUser, silentLog } from './helpers.js';
import type { Env, TestDb } from './helpers.js';

let tdb: TestDb;
let env: Env;
const DAY = 24 * 3_600_000;
const now = new Date('2026-10-08T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

beforeAll(async () => {
  tdb = await createTestDb();
  env = await createEnv(tdb.db);
});

afterAll(async () => {
  await env?.close();
  await tdb?.close();
});

const exists = (p: string) => access(p).then(() => true, () => false);

async function put(file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'x');
}

async function video(owner: string, fields: { status: string; created_at?: Date; published_at?: Date | null; deleted_at?: Date | null; withDelivery?: boolean }) {
  const id = uuidv7();
  const key = `originals/${owner}/${id}.mp4`;
  await put(env.storage.originalPath(key));
  if (fields.withDelivery) {
    await put(env.storage.deliveryPath(playbackKey(id)));
    await put(env.storage.deliveryPath(thumbnailKey(id)));
  }
  await env.db
    .insertInto('videos')
    .values({
      id, owner_user_id: owner, original_key: key, declared_type: 'video/mp4', size_bytes: 1, title: 't', status: fields.status,
      created_at: fields.created_at ?? ago(DAY), published_at: fields.published_at ?? null, deleted_at: fields.deleted_at ?? null,
      playback_key: fields.withDelivery ? playbackKey(id) : null, thumbnail_key: fields.withDelivery ? thumbnailKey(id) : null,
    })
    .execute();
  return { id, original: env.storage.originalPath(key), playback: env.storage.deliveryPath(playbackKey(id)), thumb: env.storage.deliveryPath(thumbnailKey(id)) };
}

describe('maintenance', () => {
  it('cleans storage according to each video state and is idempotent', async () => {
    const owner = await seedUser(env.db);
    const abandoned = await video(owner, { status: 'uploading', created_at: ago(2 * DAY) });
    const freshUpload = await video(owner, { status: 'uploading', created_at: ago(3_600_000) });
    const rejected = await video(owner, { status: 'rejected' });
    const recentPublished = await video(owner, { status: 'published', published_at: ago(2 * DAY), withDelivery: true });
    const oldPublished = await video(owner, { status: 'published', published_at: ago(8 * DAY), withDelivery: true });
    const deleted = await video(owner, { status: 'deleted', published_at: ago(3 * DAY), deleted_at: ago(3_600_000), withDelivery: true });
    const processing = await video(owner, { status: 'processing' });
    await env.db.insertInto('rate_limit_hits').values([
      { key: 'old', count: 3, reset_at: ago(2 * 3_600_000) },
      { key: 'live', count: 1, reset_at: new Date(now.getTime() + 60_000) },
    ]).execute();

    const report = await runMaintenance(env.db, env.storage, silentLog, now, DEFAULT_MAINTENANCE);

    // The abandoned upload is failed first, then its original goes in the same run.
    expect((await getVideo(env.db, abandoned.id)).status).toBe('failed');
    expect(await exists(abandoned.original)).toBe(false);
    expect((await getVideo(env.db, freshUpload.id)).status).toBe('uploading');
    expect(await exists(freshUpload.original)).toBe(true);
    expect(await exists(rejected.original)).toBe(false);
    expect(await exists(recentPublished.original)).toBe(true);
    expect(await exists(oldPublished.original)).toBe(false);
    expect(await exists(oldPublished.playback)).toBe(true);
    expect(await exists(deleted.original)).toBe(false);
    expect(await exists(deleted.playback)).toBe(false);
    expect(await exists(deleted.thumb)).toBe(false);
    expect(await exists(recentPublished.playback)).toBe(true);
    expect(await exists(processing.original)).toBe(true);
    expect((await getVideo(env.db, deleted.id)).delivery_purged_at).toBeInstanceOf(Date);
    const keys = (await env.db.selectFrom('rate_limit_hits').select('key').execute()).map((r) => r.key);
    expect(keys).toEqual(['live']);
    // The first run also rolls up the analytics backfill window (35 days); later runs that day have nothing to roll.
    expect(report).toEqual({ abandonedUploads: 1, originalsPurged: 4, deliveryPurged: 1, rateLimitRowsPruned: 1, alertNotifications: 0, analyticsDaysRolled: 35, analyticsEventsDeleted: 0, errors: 0, challenges: expect.any(Object) });

    const again = await runMaintenance(env.db, env.storage, silentLog, now, DEFAULT_MAINTENANCE);
    expect(again).toEqual({ abandonedUploads: 0, originalsPurged: 0, deliveryPurged: 0, rateLimitRowsPruned: 0, alertNotifications: 0, analyticsDaysRolled: 0, analyticsEventsDeleted: 0, errors: 0, challenges: expect.any(Object) });
  });

  it('keeps going and reports when storage fails for one video', async () => {
    const owner = await seedUser(env.db);
    const a = await video(owner, { status: 'rejected' });
    const failing = { ...env.storage, deleteObjects: async () => { throw new Error('storage down'); } } as unknown as typeof env.storage;
    const report = await runMaintenance(env.db, failing, silentLog, now, DEFAULT_MAINTENANCE);
    expect(report.errors).toBeGreaterThanOrEqual(1);
    expect((await getVideo(env.db, a.id)).original_purged_at).toBeNull();
  });
});
