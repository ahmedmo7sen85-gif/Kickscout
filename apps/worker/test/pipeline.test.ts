import { readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Analysis, VideoAnalyzer } from '../src/analyzer/types.js';
import { PermanentJobError } from '../src/errors.js';
import { processVideo } from '../src/pipeline.js';
import { playbackKey, thumbnailKey } from '../src/storage/storage.js';
import {
  FakeAnalyzer, SAFE, casesFor, createEnv, createTestDb, getJob, getVideo, makeClips, notificationsFor, probeDuration, probeSize,
  seedUser, seedVideo,
} from './helpers.js';
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

/** Runs every ready job with this analyzer. */
async function drain(analyzer: VideoAnalyzer | null) {
  const worker = env.worker(analyzer);
  while (await worker.runOnce()) { /* keep going */ }
}

const flagged = (categories: Analysis['moderation']['categories']): Analysis => ({
  ...SAFE,
  moderation: { verdict: 'flagged', categories, explanation: 'Possibly concerning.' },
});

describe('video.process', () => {
  it('transcodes, thumbnails, AI-tags and publishes a valid clip', async () => {
    const owner = await seedUser(env.db);
    const { videoId, jobId } = await seedVideo(env, { owner, clip: clips.valid });
    const analyzer = FakeAnalyzer.returning(SAFE);
    await drain(analyzer);

    const v = await getVideo(env.db, videoId);
    expect(v.status).toBe('published');
    expect(v.published_at).toBeInstanceOf(Date);
    expect(v.moderation).toBe('safe');
    expect(v.detected_format).toBe('mp4');
    expect([v.width, v.height]).toEqual([320, 240]);
    expect(v.duration_ms).toBeGreaterThanOrEqual(2900);
    expect(v.duration_ms).toBeLessThanOrEqual(3100);
    expect(v.sha256?.length).toBe(32);
    expect(v.football_present).toBe(true);
    expect(v.players_visible).toBe(1);
    expect(v.playback_key).toBe(playbackKey(videoId));
    expect(v.thumbnail_key).toBe(thumbnailKey(videoId));
    expect((v.ai_summary as { result: Analysis }).result.moderation.verdict).toBe('safe');

    const out = await probeSize(env.storage.deliveryPath(playbackKey(videoId)));
    expect(out).toEqual({ width: 320, height: 240, codec: 'h264' });
    const head = (await readFile(env.storage.deliveryPath(playbackKey(videoId)))).subarray(0, 64).toString('latin1');
    expect(head.indexOf('moov')).toBeGreaterThan(0); // +faststart puts the index before the media data
    const thumb = await readFile(env.storage.deliveryPath(thumbnailKey(videoId)));
    expect(thumb.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    expect(analyzer.calls).toHaveLength(1);
    expect(analyzer.calls[0]!.frames).toHaveLength(6);
    for (const f of analyzer.calls[0]!.frames) expect(f.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    const tags = await env.db.selectFrom('video_skills').selectAll().where('video_id', '=', videoId).orderBy('skill_key').execute();
    // elastico at 0.2 is under the 0.4 floor and dropped
    expect(tags.map((t) => [t.skill_key, t.source, Number(t.confidence)])).toEqual([
      ['ball_control', 'ai', 0.55],
      ['juggling', 'ai', 0.82],
    ]);

    const notes = await notificationsFor(env.db, owner);
    expect(notes.map((n) => n.kind)).toEqual(['video.published']);
    expect(await casesFor(env.db, videoId)).toHaveLength(0);
    const audit = await env.db.selectFrom('audit_logs').selectAll().where('target_id', '=', videoId).execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'ai.moderation', actor_id: null });
    expect((await getJob(env.db, jobId)).status).toBe('done');
  });

  it('is idempotent: a second run of the same job leaves a published video alone', async () => {
    const owner = await seedUser(env.db);
    const { videoId } = await seedVideo(env, { owner, clip: clips.valid });
    const analyzer = FakeAnalyzer.returning(SAFE);
    await drain(analyzer);
    const result = await processVideo(env.deps(analyzer), videoId);
    expect(result).toEqual({ outcome: 'skipped', reason: 'video is published' });
    expect(analyzer.calls).toHaveLength(1);
    expect(await notificationsFor(env.db, owner)).toHaveLength(1);
  });

  it('skips deleted videos', async () => {
    const owner = await seedUser(env.db);
    const { videoId, jobId } = await seedVideo(env, { owner, clip: clips.valid, status: 'deleted' });
    const analyzer = FakeAnalyzer.returning(SAFE);
    await drain(analyzer);
    expect(analyzer.calls).toHaveLength(0);
    expect((await getVideo(env.db, videoId)).status).toBe('deleted');
    expect((await getJob(env.db, jobId)).status).toBe('done');
    expect(await notificationsFor(env.db, owner)).toHaveLength(0);
  });

  it('keeps vertical video vertical and caps the short side at 720', async () => {
    const owner = await seedUser(env.db);
    const a = await seedVideo(env, { owner, clip: clips.vertical });
    const b = await seedVideo(env, { owner, clip: clips.hd });
    await drain(FakeAnalyzer.returning(SAFE));
    expect(await probeSize(env.storage.deliveryPath(playbackKey(a.videoId)))).toMatchObject({ width: 400, height: 640 });
    expect(await probeSize(env.storage.deliveryPath(playbackKey(b.videoId)))).toMatchObject({ width: 1280, height: 720 });
    const v = await getVideo(env.db, a.videoId);
    expect([v.width, v.height]).toEqual([400, 640]);
  });

  it('accepts WebM', async () => {
    const owner = await seedUser(env.db);
    const { videoId } = await seedVideo(env, { owner, clip: clips.webm, declaredType: 'video/webm' });
    await drain(FakeAnalyzer.returning(SAFE));
    const v = await getVideo(env.db, videoId);
    expect(v.status).toBe('published');
    expect(v.detected_format).toBe('webm');
  });

  it('applies the trim to the output', async () => {
    const owner = await seedUser(env.db);
    const { videoId } = await seedVideo(env, { owner, clip: clips.six, trimStartMs: 1000, trimEndMs: 3500 });
    await drain(FakeAnalyzer.returning(SAFE));
    const v = await getVideo(env.db, videoId);
    expect(v.status).toBe('published');
    expect(v.duration_ms).toBe(2500);
    const seconds = await probeDuration(env.storage.deliveryPath(playbackKey(videoId)));
    expect(seconds).toBeGreaterThan(2.3);
    expect(seconds).toBeLessThan(2.7);
  });

  it('rejects a text file named .mp4 with a lying declared type, without retrying or calling the AI', async () => {
    const owner = await seedUser(env.db);
    const { videoId, jobId } = await seedVideo(env, { owner, clip: clips.text, declaredType: 'video/mp4' });
    const analyzer = FakeAnalyzer.returning(SAFE);
    await drain(analyzer);
    const v = await getVideo(env.db, videoId);
    expect(v.status).toBe('rejected');
    expect(v.status_reason).toMatch(/not a video/i);
    expect(v.playback_key).toBeNull();
    expect(analyzer.calls).toHaveLength(0);
    const job = await getJob(env.db, jobId);
    expect(job.status).toBe('done');
    expect(job.attempts).toBe(1);
    const notes = await notificationsFor(env.db, owner);
    expect(notes.map((n) => n.kind)).toEqual(['video.rejected']);
    expect((notes[0]!.payload as { reason: string }).reason).toBe(v.status_reason);
  });

  it('rejects a clip longer than 180 s after trim', async () => {
    const owner = await seedUser(env.db);
    const { videoId } = await seedVideo(env, { owner, clip: clips.long, trimStartMs: 5000 });
    await drain(FakeAnalyzer.returning(SAFE));
    const v = await getVideo(env.db, videoId);
    expect(v.status).toBe('rejected');
    expect(v.status_reason).toMatch(/195 seconds.*180/);
  });

  it("rejects a clip over the uploader's plan limit even when it is under the global cap", async () => {
    const owner = await seedUser(env.db);
    const { videoId } = await seedVideo(env, { owner, clip: clips.long, trimStartMs: 0, trimEndMs: 90_000, maxDurationMs: 60_000 });
    await drain(FakeAnalyzer.returning(SAFE));
    const v = await getVideo(env.db, videoId);
    expect(v.status).toBe('rejected');
    expect(v.status_reason).toMatch(/90 seconds.*limit is 60 seconds/);
  });

  it('accepts the same long clip once trimmed under 180 s', async () => {
    const owner = await seedUser(env.db);
    const { videoId } = await seedVideo(env, { owner, clip: clips.long, trimStartMs: 10_000, trimEndMs: 20_000 });
    await drain(FakeAnalyzer.returning(SAFE));
    const v = await getVideo(env.db, videoId);
    expect(v.status).toBe('published');
    expect(v.duration_ms).toBe(10_000);
  });

  it('rejects resolution below 240p and truncated files', async () => {
    const owner = await seedUser(env.db);
    const tiny = await seedVideo(env, { owner, clip: clips.tiny });
    const broken = await seedVideo(env, { owner, clip: clips.truncated });
    await drain(FakeAnalyzer.returning(SAFE));
    expect(await getVideo(env.db, tiny.videoId)).toMatchObject({ status: 'rejected', status_reason: expect.stringMatching(/too low/) });
    expect(await getVideo(env.db, broken.videoId)).toMatchObject({ status: 'rejected', status_reason: expect.stringMatching(/damaged/) });
  });

  it('sends a flagged verdict to review with an open moderation case', async () => {
    const owner = await seedUser(env.db, 'adult');
    const { videoId } = await seedVideo(env, { owner, clip: clips.valid });
    await drain(FakeAnalyzer.returning(flagged(['dangerous'])));
    const v = await getVideo(env.db, videoId);
    expect(v.status).toBe('review_required');
    expect(v.moderation).toBe('flagged');
    expect(v.published_at).toBeNull();
    const cases = await casesFor(env.db, videoId);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ status: 'open', source: 'ai', target_kind: 'video', categories: ['dangerous'], priority: 1 });
    expect((cases[0]!.ai_verdict as { result: Analysis }).result.moderation.verdict).toBe('flagged');
    // AI tags are still recorded as suggestions for the reviewer
    expect(await env.db.selectFrom('video_skills').selectAll().where('video_id', '=', videoId).execute()).toHaveLength(2);
    expect((await notificationsFor(env.db, owner)).map((n) => n.kind)).toEqual(['video.review_required']);
  });

  it("gives a minor owner's flagged video priority 0", async () => {
    const owner = await seedUser(env.db, 'u16');
    const { videoId } = await seedVideo(env, { owner, clip: clips.valid });
    await drain(FakeAnalyzer.returning(flagged(['spam'])));
    const cases = await casesFor(env.db, videoId);
    expect(cases[0]).toMatchObject({ priority: 0, categories: ['spam'] });
  });

  it('sends non-football content to review rather than deleting it', async () => {
    const owner = await seedUser(env.db);
    const { videoId } = await seedVideo(env, { owner, clip: clips.valid });
    await drain(FakeAnalyzer.returning({ ...SAFE, footballPresent: false, skills: [], context: 'other' }));
    expect((await getVideo(env.db, videoId)).status).toBe('review_required');
    expect((await casesFor(env.db, videoId))[0]).toMatchObject({ categories: ['non_football'], priority: 2 });
  });

  it('rejects only clear severe violations', async () => {
    const owner = await seedUser(env.db);
    const severe = await seedVideo(env, { owner, clip: clips.valid });
    await drain(FakeAnalyzer.returning({ ...SAFE, moderation: { verdict: 'rejected', categories: ['graphic_violence'], explanation: 'Graphic injury.' } }));
    expect(await getVideo(env.db, severe.videoId)).toMatchObject({ status: 'rejected', moderation: 'rejected' });
    expect(await casesFor(env.db, severe.videoId)).toHaveLength(0);

    // 'rejected' with only a mild category is not clear-cut: a human decides
    const mild = await seedVideo(env, { owner, clip: clips.valid });
    await drain(FakeAnalyzer.returning({ ...SAFE, moderation: { verdict: 'rejected', categories: ['spam'], explanation: 'Looks like spam.' } }));
    expect((await getVideo(env.db, mild.videoId)).status).toBe('review_required');
  });

  it('without an AI key, never publishes: review_required with an ai_unavailable case', async () => {
    const owner = await seedUser(env.db);
    const { videoId } = await seedVideo(env, { owner, clip: clips.valid });
    await drain(null);
    const v = await getVideo(env.db, videoId);
    expect(v.status).toBe('review_required');
    expect(v.moderation).toBeNull();
    expect(v.playback_key).toBe(playbackKey(videoId)); // still transcoded so a moderator can watch it
    expect((await casesFor(env.db, videoId))[0]).toMatchObject({ categories: ['ai_unavailable'], status: 'open', priority: 2 });
    const audit = await env.db.selectFrom('audit_logs').select('metadata').where('target_id', '=', videoId).executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({ verdict: 'unavailable', decision: 'review_required' });
  });

  it('treats an analyzer refusal as review_required with its explanation', async () => {
    const owner = await seedUser(env.db);
    const { videoId } = await seedVideo(env, { owner, clip: clips.valid });
    await drain(new FakeAnalyzer(() => ({ kind: 'refusal', explanation: 'Declined by policy.', category: null, model: 'fake-model' })));
    const v = await getVideo(env.db, videoId);
    expect(v.status).toBe('review_required');
    expect(v.ai_summary).toMatchObject({ refused: true, explanation: 'Declined by policy.' });
    expect((await casesFor(env.db, videoId))[0]).toMatchObject({ categories: ['ai_refused'], priority: 1 });
  });

  it('flags a byte-identical upload from a different owner as a possibly stolen video', async () => {
    const original = await seedUser(env.db);
    const copier = await seedUser(env.db);
    const first = await seedVideo(env, { owner: original, clip: clips.six, unique: false });
    await drain(FakeAnalyzer.returning(SAFE));
    expect((await getVideo(env.db, first.videoId)).status).toBe('published');

    // the same owner uploading it again is not theft
    const again = await seedVideo(env, { owner: original, clip: clips.six, unique: false });
    const copy = await seedVideo(env, { owner: copier, clip: clips.six, unique: false });
    await drain(FakeAnalyzer.returning(SAFE));
    expect((await getVideo(env.db, again.videoId)).status).toBe('published');
    const v = await getVideo(env.db, copy.videoId);
    expect(v.status).toBe('review_required');
    expect(v.ai_summary).toMatchObject({ duplicateOf: first.videoId });
    expect((await casesFor(env.db, copy.videoId))[0]).toMatchObject({ categories: ['stolen_video'], priority: 1, status: 'open' });
  });

  it('merges into an already open case instead of violating the one-open-case index', async () => {
    const owner = await seedUser(env.db);
    const { videoId } = await seedVideo(env, { owner, clip: clips.valid });
    await env.db
      .insertInto('moderation_cases')
      .values({ id: '0190f0a0-0000-7000-8000-000000000001', target_kind: 'video', target_id: videoId, source: 'report', categories: ['spam'], priority: 2, report_count: 1 })
      .execute();
    await drain(FakeAnalyzer.returning(flagged(['hate'])));
    const cases = await casesFor(env.db, videoId);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ source: 'report', categories: ['hate', 'spam'], priority: 1, report_count: 1 });
  });

  it('always cleans up its temp directory', async () => {
    const before = (await readdir(os.tmpdir())).filter((f) => f.startsWith('video-'));
    const owner = await seedUser(env.db);
    await seedVideo(env, { owner, clip: clips.valid });
    await seedVideo(env, { owner, clip: clips.text });
    await drain(new FakeAnalyzer(() => { throw new PermanentJobError('boom'); }));
    const after = (await readdir(os.tmpdir())).filter((f) => f.startsWith('video-'));
    expect(after.sort()).toEqual(before.sort());
  });
});
