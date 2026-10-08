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
import type { Analysis, AnalysisInput, AnalysisOutcome, VideoAnalyzer } from '../src/analyzer/types.js';
import { LocalVideoStorage } from '../src/storage/local.js';
import type { Logger, PipelineDeps } from '../src/pipeline.js';
import { Worker } from '../src/worker.js';
import type { WorkerOptions } from '../src/worker.js';

const exec = promisify(execFile);
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://fp:fp@localhost:5432/postgres';
export const FFMPEG = '/usr/bin/ffmpeg';
export const FFPROBE = '/usr/bin/ffprobe';

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
  // Truncated: keep the moov-less head of a non-faststart file so the decoder sees a broken stream.
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=4', ...x264, '-movflags', '+faststart', p('full.mp4')]);
  const full = await readFile(p('full.mp4'));
  await writeFile(p('truncated.mp4'), full.subarray(0, Math.floor(full.length * 0.6)));
  return {
    dir, valid: p('valid.mp4'), six: p('six.mp4'), vertical: p('vertical.mp4'), hd: p('hd.mp4'), long: p('long.mp4'),
    tiny: p('tiny.mp4'), webm: p('clip.webm'), text: p('text.mp4'), truncated: p('truncated.mp4'),
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

// ---------------------------------------------------------------- analyzers

export const SAFE: Analysis = {
  footballPresent: true,
  playersVisible: 1,
  context: 'training',
  skills: [
    { key: 'juggling', confidence: 0.82 },
    { key: 'ball_control', confidence: 0.55 },
    { key: 'elastico', confidence: 0.2 },
  ],
  moderation: { verdict: 'safe', categories: [], explanation: 'A player juggling a ball on a pitch.' },
};

export class FakeAnalyzer implements VideoAnalyzer {
  readonly calls: AnalysisInput[] = [];
  constructor(private readonly respond: (input: AnalysisInput) => AnalysisOutcome | Promise<AnalysisOutcome>) {}
  async analyze(input: AnalysisInput) {
    this.calls.push(input);
    return this.respond(input);
  }
  static returning(analysis: Analysis) {
    return new FakeAnalyzer(() => ({ kind: 'result', analysis, model: 'fake-model' }));
  }
}

// ---------------------------------------------------------------- environment

export interface Env {
  db: Database;
  storage: LocalVideoStorage;
  root: string;
  deps(analyzer: VideoAnalyzer | null): PipelineDeps;
  worker(analyzer: VideoAnalyzer | null, opts?: Partial<WorkerOptions>): Worker;
  close(): Promise<void>;
}

export async function createEnv(db: Database): Promise<Env> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fp-worker-storage-'));
  const storage = new LocalVideoStorage(root);
  const deps = (analyzer: VideoAnalyzer | null): PipelineDeps => ({
    db, storage, analyzer, media: { ffmpeg: FFMPEG, ffprobe: FFPROBE }, maxOriginalBytes: 50 * 1024 * 1024, log: silentLog,
  });
  return {
    db, storage, root, deps,
    worker: (analyzer, opts = {}) =>
      new Worker(deps(analyzer), { concurrency: 1, jobTimeoutMs: 60_000, pollIntervalMs: 50, retryBaseMs: 1_000, ...opts }),
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
  /** Append a unique MP4 'free' box so each upload has its own sha256 (default true for .mp4 clips). */
  unique?: boolean;
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
      size_bytes: 1000, title: 'Test clip', trim_start_ms: v.trimStartMs ?? null, trim_end_ms: v.trimEndMs ?? null,
    })
    .execute();
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
