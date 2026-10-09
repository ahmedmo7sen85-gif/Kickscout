import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDb } from '@fp/db';
import type { Database } from '@fp/db';
import { createGuardianClassifiers } from './guardian/factory.js';
import { policyFromEnv } from './guardian/service.js';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { runMaintenance } from './maintenance.js';
import { queueDepth } from './queue.js';
import type { MaintenanceReport } from './maintenance.js';
import type { Logger } from './pipeline.js';
import { S3VideoStorage } from './storage/s3.js';
import { Worker } from './worker.js';

const log: Logger = {
  info: (msg, fields) => console.log(JSON.stringify({ level: 'info', msg, ...fields })),
  warn: (msg, fields) => console.warn(JSON.stringify({ level: 'warn', msg, ...fields })),
  error: (msg, fields) => console.error(JSON.stringify({ level: 'error', msg, ...fields })),
};

export interface BatchReport {
  jobs: number;
  ms: number;
  /** Outcomes of the jobs run in this batch. */
  outcomes: { done: number; retried: number; failed: number };
  /** Queue depth after the batch. */
  queue: { queued: number; running: number; failed24h: number } | null;
  maintenance: MaintenanceReport | null;
}

interface Runtime {
  config: Config;
  db: Database;
  worker: Worker;
  storage: S3VideoStorage;
}

let runtime: Runtime | null = null;

/** Built once per function instance and reused by later invocations. */
function getRuntime(): Runtime {
  if (runtime) return runtime;
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL, 2);
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
  const classifiers = createGuardianClassifiers(config.ANTHROPIC_API_KEY, db, log);
  const policy = policyFromEnv();
  const worker = new Worker(
    { db, storage, classifiers, policy, media: { ffmpeg: config.FFMPEG_PATH, ffprobe: config.FFPROBE_PATH }, maxOriginalBytes: config.MAX_ORIGINAL_BYTES, workDir: config.WORK_DIR, log },
    { concurrency: 1, jobTimeoutMs: config.JOB_TIMEOUT_MS, pollIntervalMs: config.JOB_POLL_INTERVAL_MS, retryBaseMs: config.JOB_RETRY_BASE_MS },
  );
  runtime = { config, db, worker, storage };
  return runtime;
}

/** Recovers jobs from instances that were cut off, then runs queued jobs one at a time until the queue is empty or the budget is spent. */
export async function runBatch(worker: Worker, opts: { claimBudgetMs: number }): Promise<number> {
  const started = Date.now();
  await worker.recoverStale();
  let jobs = 0;
  while (Date.now() - started < opts.claimBudgetMs) {
    if (!(await worker.runOnce())) break;
    jobs++;
  }
  return jobs;
}

function bearerMatches(header: string | undefined, secrets: (string | undefined)[]): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  return secrets.some((s) => {
    if (!s) return false;
    const want = Buffer.from(s);
    return want.length === given.length && timingSafeEqual(want, given);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Vercel function entry. Called by the API right after an upload completes (WORKER_TRIGGER_SECRET) and by the
 * daily cron (CRON_SECRET, sent by Vercel). Runs to completion before responding: the API does not wait for the
 * answer, and Vercel keeps the function running after the caller disconnects.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const secrets = [process.env.WORKER_TRIGGER_SECRET, process.env.CRON_SECRET].filter((s) => s && s.length >= 32);
  if (secrets.length === 0) return send(res, 503, { error: 'worker trigger is not configured' });
  if (!bearerMatches(req.headers.authorization, secrets)) return send(res, 401, { error: 'unauthorized' });

  const started = Date.now();
  try {
    const rt = getRuntime();
    const before = { ...rt.worker.stats };
    const jobs = await runBatch(rt.worker, { claimBudgetMs: rt.config.SERVERLESS_CLAIM_BUDGET_MS });
    const maintenance = await runMaintenance(rt.db, rt.storage, log);
    const queue = await queueDepth(rt.db).catch(() => null);
    const s = rt.worker.stats;
    const outcomes = { done: s.done - before.done, retried: s.retried - before.retried, failed: s.failed - before.failed };
    const report: BatchReport = { jobs, ms: Date.now() - started, outcomes, queue, maintenance };
    log.info('worker batch finished', { ...report });
    send(res, 200, report);
  } catch (err) {
    log.error('worker batch failed', { error: (err as Error).message });
    send(res, 500, { error: 'worker batch failed' });
  }
}
