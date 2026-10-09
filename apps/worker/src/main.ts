import { createDb } from '@fp/db';
import { createVideoAnalyzer } from './analyzer/factory.js';
import { loadConfig } from './config.js';
import type { Logger } from './pipeline.js';
import { S3VideoStorage } from './storage/s3.js';
import { Worker } from './worker.js';

const log: Logger = {
  info: (msg, fields) => console.log(JSON.stringify({ level: 'info', msg, ...fields, time: new Date().toISOString() })),
  warn: (msg, fields) => console.warn(JSON.stringify({ level: 'warn', msg, ...fields, time: new Date().toISOString() })),
  error: (msg, fields) => console.error(JSON.stringify({ level: 'error', msg, ...fields, time: new Date().toISOString() })),
};

const config = loadConfig();
const db = createDb(config.DATABASE_URL, Math.max(config.DATABASE_POOL_MAX, config.WORKER_CONCURRENCY + 2));

const storage = new S3VideoStorage({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  credentials:
    config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
      : undefined,
  originalsBucket: config.S3_BUCKET_ORIGINALS,
  deliveryBucket: config.S3_BUCKET_DELIVERY,
});

const analyzer = createVideoAnalyzer(config.ANTHROPIC_API_KEY, db, log);
if (!analyzer) log.warn('ANTHROPIC_API_KEY is not set: every video will wait for human review');

const worker = new Worker(
  { db, storage, analyzer, media: { ffmpeg: config.FFMPEG_PATH, ffprobe: config.FFPROBE_PATH }, maxOriginalBytes: config.MAX_ORIGINAL_BYTES, workDir: config.WORK_DIR, log },
  { concurrency: config.WORKER_CONCURRENCY, jobTimeoutMs: config.JOB_TIMEOUT_MS, pollIntervalMs: config.JOB_POLL_INTERVAL_MS, retryBaseMs: config.JOB_RETRY_BASE_MS },
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down, finishing jobs in flight', { signal });
  await worker.stop();
  await db.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

worker.start();
