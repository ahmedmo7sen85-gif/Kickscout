import { randomBytes } from 'node:crypto';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { createDb, migrate } from '@fp/db';
import type { Database } from '@fp/db';
import { AiRouter, FakeAiProvider, dbCallRecorder, fakeResponse, routingFromEnv } from '@fp/ai';
import type { AiRequest } from '@fp/ai';
import type { GuardianPolicy } from '@fp/domain';
import type { CategoryProbability } from '../src/guardian/types.js';
import { guardianClassifiers } from '../src/guardian/factory.js';
import type { GuardianClassifiers } from '../src/guardian/service.js';
import { LocalVideoStorage } from '../src/storage/local.js';
import type { Logger, PipelineDeps } from '../src/pipeline.js';
import { Worker } from '../src/worker.js';
import type { WorkerOptions } from '../src/worker.js';

const exec = promisify(execFile);
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://fp:fp@localhost:5432/postgres';
// Overridable so the suite can run against the static binaries the Vercel worker ships.
export const FFMPEG = process.env.TEST_FFMPEG ?? '/usr/bin/ffmpeg';
export const FFPROBE = process.env.TEST_FFPROBE ?? '/usr/bin/ffprobe';

export const silentLog: Logger = { info() {}, warn() {}, error() {} };

export interface TestDb {
  db: Database;
  url: string;
  close(): Promise<void>;
}

/** A fresh, migrated database per test file, dropped afterwards. */
export async function createTestDb(): Promise<TestDb> {
  const name = `fp_worker_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  admin.on('error', () => {});
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  await migrate(url.toString());
  const db = createDb(url.toString(), 8);
  return {
    db,
    url: url.toString(),
    async close() {
      await db.destroy();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

// ---------------------------------------------------------------- clips

async function ffmpeg(args: string[]) {
  await exec(FFMPEG, ['-nostdin', '-v', 'error', '-y', ...args], { timeout: 120_000 });
}

export interface Clips {
  dir: string;
  /** 320x240, 3 s, with audio. */
  valid: string;
  /** 6 s, 320x240, for trim tests. */
  six: string;
  /** 400x640 vertical, 2 s, no audio. */
  vertical: string;
  /** 1920x1080 landscape, 2 s: must come out at 720 on the short side. */
  hd: string;
  /** 200 s at 1 fps and tiny bitrate. */
  long: string;
  /** 160x120: below the resolution floor. */
  tiny: string;
  /** VP9 WebM, 2 s. */
  webm: string;
  /** Plain text with an .mp4 name. */
  text: string;
  /** First half of a valid MP4: a truncated upload. */
  truncated: string;
  /** 9 s: 4 s of test pattern, a 1 s "inserted" scene of colour bars at 4-5 s, then 4 s of test pattern. */
  spliced: string;
  /** 4 s of a moving fractal: distinctive frames for perceptual-hash tests. */
  textured: string;
  /** The same fractal clip mirrored, cropped, rescaled and re-encoded: an edited re-upload. */
  texturedEdited: string;
}

export async function makeClips(): Promise<Clips> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fp-worker-clips-'));
  const p = (f: string) => path.join(dir, f);
  const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  await Promise.all([
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', ...x264, '-c:a', 'aac', '-shortest', p('valid.mp4')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=6', ...x264, p('six.mp4')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=400x640:rate=10:duration=2', ...x264, p('vertical.mp4')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=5:duration=2', ...x264, p('hd.mp4')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1:duration=200', ...x264, '-g', '300', p('long.mp4')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2', ...x264, p('tiny.mp4')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', p('clip.webm')]),
    writeFile(p('text.mp4'), 'this is not a video, just text pretending to be one\n'.repeat(20)),
  ]);
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=4', '-f', 'lavfi', '-i', 'smptebars=size=320x240:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=4', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', ...x264, p('spliced.mp4'),
  ]);
  await ffmpeg(['-f', 'lavfi', '-i', 'mandelbrot=size=320x240:rate=10', '-t', '4', ...x264, p('textured.mp4')]);
  await ffmpeg(['-i', p('textured.mp4'), '-vf', 'hflip,crop=iw*0.92:ih*0.92,scale=352:264', ...x264, '-crf', '30', p('textured-edited.mp4')]);
  // Truncated: keep the moov-less head of a non-faststart file so the decoder sees a broken stream.
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=4', ...x264, '-movflags', '+faststart', p('full.mp4')]);
  const full = await readFile(p('full.mp4'));
  await writeFile(p('truncated.mp4'), full.subarray(0, Math.floor(full.length * 0.6)));
  return {
    dir, valid: p('valid.mp4'), six: p('six.mp4'), vertical: p('vertical.mp4'), hd: p('hd.mp4'), long: p('long.mp4'),
    tiny: p('tiny.mp4'), webm: p('clip.webm'), text: p('text.mp4'), truncated: p('truncated.mp4'),
    spliced: p('spliced.mp4'), textured: p('textured.mp4'), texturedEdited: p('textured-edited.mp4'),
  };
}

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number.parseFloat(stdout.trim());
}

export async function probeSize(file: string): Promise<{ width: number; height: number; codec: string }> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', file]);
  const s = JSON.parse(stdout).streams[0];
  return { width: s.width, height: s.height, codec: s.codec_name };
}

// ---------------------------------------------------------------- scripted AI

export interface Segment {
  fromMs: number;
  toMs: number;
  football?: boolean;
  categories?: CategoryProbability[];
}

export interface Script {
  /** What each part of the clip "shows". Defaults to football everywhere. */
  segments?: Segment[];
  footballRelevance?: number;
  staticImage?: boolean;
  minorsMayBePresent?: boolean;
  confidence?: number;
  metadataText?: CategoryProbability[];
  onScreenText?: CategoryProbability[];
  /** Overrides for the deep (second) look only: a different opinion. */
  deep?: Omit<Script, 'deep' | 'refuse'>;
  refuse?: 'screen' | 'deep';
  skills?: { key: string; confidence: number }[];
}

export const SCREEN_MODEL = 'claude-haiku-5-5';
export const DEEP_MODEL = 'claude-opus-5-5';

/** Frame times the classifier was shown, parsed from the "Frame i of n, at X s" labels. */
export function frameTimes(req: AiRequest): number[] {
  return req.content.flatMap((c) => (c.type === 'text' ? [...c.text.matchAll(/^Frame \d+ of \d+, at ([0-9.]+) s:/g)].map((m) => Math.round(Number(m[1]) * 1000)) : []));
}

/**
 * A fake provider that answers like a classifier looking at a clip described by `script`: each frame is
 * labelled from the segment its timestamp falls in. Lets tests check that sampling really covers the
 * whole clip (a prohibited segment is only reported if a frame lands in it).
 */
export function scriptedProvider(script: Script = {}): FakeAiProvider {
  return new FakeAiProvider((req) => {
    const deep = req.model === DEEP_MODEL;
    if (script.refuse === (deep ? 'deep' : 'screen')) {
      return fakeResponse({ stop: 'refusal', rawStop: 'refusal', model: req.model, refusal: { explanation: 'Declined.', category: null } });
    }
    const s: Omit<Script, 'deep'> = deep ? { ...script, ...script.deep } : script;
    const times = frameTimes(req);
    const frames = times.map((t, i) => {
      const seg = s.segments?.find((g) => t >= g.fromMs && t < g.toMs);
      return { frame: i + 1, football: seg?.football ?? true, categories: seg?.categories ?? [] };
    });
    const share = frames.length ? frames.filter((f) => f.football).length / frames.length : 0;
    const body: Record<string, unknown> = {
      footballRelevance: s.footballRelevance ?? (share >= 0.5 ? 0.95 : share > 0 ? 0.5 : 0.03),
      footballKind: share > 0 ? 'skills' : 'none',
      staticImage: s.staticImage ?? false,
      minorsMayBePresent: s.minorsMayBePresent ?? false,
      frames,
      onScreenText: s.onScreenText ?? [],
      metadataText: s.metadataText ?? [],
      confidence: s.confidence ?? 0.9,
      explanation: 'Scripted answer.',
    };
    if (deep) Object.assign(body, { playersVisible: 1, context: 'training', skills: s.skills ?? [{ key: 'juggling', confidence: 0.82 }, { key: 'ball_control', confidence: 0.55 }, { key: 'elastico', confidence: 0.2 }] });
    return fakeResponse({ text: JSON.stringify(body), model: req.model, usage: { inputTokens: 200 * times.length + 900, outputTokens: 300 } });
  });
}

export interface Ai {
  provider: FakeAiProvider;
  classifiers: GuardianClassifiers;
}

/** Guardian classifiers on a scripted provider, with routing defaults (screen on the light model, deep on the heavy one). */
export function scriptedAi(db: Database, script: Script = {}, provider = scriptedProvider(script)): Ai {
  const router = new AiRouter(provider, routingFromEnv({}), { recorder: dbCallRecorder(db, uuidv7), sleep: async () => {} });
  return { provider, classifiers: guardianClassifiers(router) };
}

// ---------------------------------------------------------------- environment

export interface Env {
  db: Database;
  storage: LocalVideoStorage;
  root: string;
  deps(classifiers: GuardianClassifiers | null, policy?: GuardianPolicy): PipelineDeps;
  worker(classifiers: GuardianClassifiers | null, opts?: Partial<WorkerOptions>, policy?: GuardianPolicy): Worker;
  close(): Promise<void>;
}

export async function createEnv(db: Database): Promise<Env> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fp-worker-storage-'));
  const storage = new LocalVideoStorage(root);
  const deps = (classifiers: GuardianClassifiers | null, policy?: GuardianPolicy): PipelineDeps => ({
    db, storage, classifiers, policy, media: { ffmpeg: FFMPEG, ffprobe: FFPROBE }, maxOriginalBytes: 50 * 1024 * 1024, log: silentLog,
  });
  return {
    db, storage, root, deps,
    worker: (classifiers, opts = {}, policy) =>
      new Worker(deps(classifiers, policy), { concurrency: 1, jobTimeoutMs: 60_000, pollIntervalMs: 50, retryBaseMs: 1_000, ...opts }),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

export async function seedUser(db: Database, ageBand: 'u13' | 'u16' | 'u18' | 'adult' = 'adult'): Promise<string> {
  const id = uuidv7();
  await db.insertInto('users').values({ id, idp_subject: `test|${id}`, status: 'active' }).execute();
  await db
    .insertInto('age_records')
    .values({ user_id: id, dob_encrypted: Buffer.from('test'), country_code: 'EG', age_band: ageBand, guardian_required: ageBand !== 'adult' })
    .execute();
  await db.insertInto('profiles').values({ user_id: id, handle: `p${id.replaceAll('-', '').slice(-12)}`, display_name: 'Test Player' }).execute();
  return id;
}

export interface SeedVideo {
  owner: string;
  clip: string;
  declaredType?: string;
  trimStartMs?: number | null;
  trimEndMs?: number | null;
  status?: string;
  /** The uploader's plan limit recorded at upload start. */
  maxDurationMs?: number | null;
  /** Append a unique MP4 'free' box so each upload has its own sha256 (default true for .mp4 clips). */
  unique?: boolean;
  title?: string;
  description?: string | null;
  hashtags?: string[];
}

/** Puts the clip in "storage" and inserts the video row as the API leaves it after upload completion, plus its job. */
export async function seedVideo(env: Env, v: SeedVideo, maxAttempts?: number): Promise<{ videoId: string; jobId: string }> {
  const videoId = uuidv7();
  const key = `originals/${v.owner}/${videoId}`;
  const dest = env.storage.originalPath(key);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(v.clip, dest);
  if ((v.unique ?? true) && v.clip.endsWith('.mp4')) {
    const payload = Buffer.from(videoId);
    const box = Buffer.alloc(8 + payload.length);
    box.writeUInt32BE(box.length, 0);
    box.write('free', 4, 'latin1');
    payload.copy(box, 8);
    await appendFile(dest, box);
  }
  await env.db
    .insertInto('videos')
    .values({
      id: videoId, owner_user_id: v.owner, status: v.status ?? 'processing', original_key: key, declared_type: v.declaredType ?? 'video/mp4',
      size_bytes: 1000, title: v.title ?? 'Test clip', description: v.description ?? null, trim_start_ms: v.trimStartMs ?? null, trim_end_ms: v.trimEndMs ?? null,
      max_duration_ms: v.maxDurationMs ?? null,
    })
    .execute();
  if (v.hashtags?.length) await env.db.insertInto('video_hashtags').values(v.hashtags.map((tag) => ({ video_id: videoId, tag }))).execute();
  const job = await env.db
    .insertInto('jobs')
    .values({ kind: 'video.process', payload: JSON.stringify({ videoId }), ...(maxAttempts ? { max_attempts: maxAttempts } : {}) })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { videoId, jobId: job.id };
}

export async function getVideo(db: Database, id: string) {
  return db.selectFrom('videos').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

export async function getJob(db: Database, id: string) {
  return db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

export async function notificationsFor(db: Database, userId: string) {
  return db.selectFrom('notifications').selectAll().where('user_id', '=', userId).orderBy('created_at').execute();
}

export async function casesFor(db: Database, videoId: string) {
  return db.selectFrom('moderation_cases').selectAll().where('target_id', '=', videoId).execute();
}
