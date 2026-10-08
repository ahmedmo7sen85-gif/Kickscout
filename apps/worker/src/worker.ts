import { z } from 'zod';
import type { Database } from '@fp/db';
import { PermanentJobError } from './errors.js';
import { markVideoFailed, processVideo } from './pipeline.js';
import type { Logger, PipelineDeps } from './pipeline.js';
import { claimJob, completeJob, failJob, heartbeat, recoverStaleJobs } from './queue.js';
import type { JobRow } from './queue.js';

export interface WorkerOptions {
  concurrency: number;
  jobTimeoutMs: number;
  pollIntervalMs: number;
  retryBaseMs: number;
}

const VideoJobPayload = z.object({ videoId: z.uuid() });

interface JobHandler {
  run(job: JobRow): Promise<void>;
  /** Runs once when the job is given up on. */
  onFailed(job: JobRow, error: string): Promise<void>;
}

export class Worker {
  private stopping = false;
  private readonly sleepers = new Set<() => void>();
  private loops: Promise<void>[] = [];
  private readonly handlers: Record<string, JobHandler>;
  private readonly db: Database;
  private readonly log: Logger;

  constructor(
    private readonly deps: PipelineDeps,
    private readonly opts: WorkerOptions,
  ) {
    this.db = deps.db;
    this.log = deps.log;
    this.handlers = {
      'video.process': {
        run: async (job) => {
          const { videoId } = parsePayload(job);
          await processVideo(this.deps, videoId);
        },
        onFailed: async (job, error) => {
          const parsed = VideoJobPayload.safeParse(job.payload);
          if (parsed.success) await markVideoFailed(this.db, parsed.data.videoId, error);
        },
      },
    };
  }

  /** Claims and runs at most one job. Returns false when nothing was ready. */
  async runOnce(): Promise<boolean> {
    const job = await claimJob(this.db);
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  /** Re-queues (or fails) jobs whose worker stopped responding. */
  async recoverStale(): Promise<void> {
    const { requeued, failed } = await recoverStaleJobs(this.db, this.opts.jobTimeoutMs);
    if (requeued > 0) this.log.warn('re-queued stale jobs', { count: requeued });
    for (const job of failed) {
      this.log.error('job timed out with no attempts left', { jobId: job.id, kind: job.kind });
      await this.handlers[job.kind]?.onFailed(job, job.last_error ?? 'timed out');
    }
  }

  private async execute(job: JobRow) {
    const started = Date.now();
    const beat = setInterval(() => {
      heartbeat(this.db, job.id).catch((err: Error) => this.log.warn('heartbeat failed', { jobId: job.id, error: err.message }));
    }, Math.max(1_000, Math.floor(this.opts.jobTimeoutMs / 3)));
    try {
      const handler = this.handlers[job.kind];
      if (!handler) throw new PermanentJobError(`unknown job kind ${job.kind}`);
      await handler.run(job);
      await completeJob(this.db, job.id);
      this.log.info('job done', { jobId: job.id, kind: job.kind, ms: Date.now() - started });
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const permanent = err instanceof PermanentJobError;
      const result = await failJob(this.db, job, error, { permanent, retryBaseMs: this.opts.retryBaseMs });
      this.log[result === 'retry' ? 'warn' : 'error']('job failed', { jobId: job.id, kind: job.kind, attempt: job.attempts, result, error });
      if (result === 'failed') await this.handlers[job.kind]?.onFailed(job, error);
    } finally {
      clearInterval(beat);
    }
  }

  start() {
    this.stopping = false;
    for (let slot = 0; slot < this.opts.concurrency; slot++) this.loops.push(this.loop(slot));
    this.log.info('worker started', { concurrency: this.opts.concurrency });
  }

  /** Stops claiming new jobs and resolves once the jobs in flight have finished. */
  async stop() {
    this.stopping = true;
    for (const wake of this.sleepers) wake();
    await Promise.all(this.loops);
    this.loops = [];
    this.log.info('worker stopped');
  }

  private async loop(slot: number) {
    let lastRecovery = 0;
    while (!this.stopping) {
      try {
        if (slot === 0 && Date.now() - lastRecovery > Math.min(60_000, this.opts.jobTimeoutMs / 2)) {
          lastRecovery = Date.now();
          await this.recoverStale();
        }
        if (await this.runOnce()) continue;
      } catch (err) {
        this.log.error('worker loop error', { error: (err as Error).message });
      }
      await this.sleep(this.opts.pollIntervalMs);
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }
}

function parsePayload(job: JobRow) {
  const parsed = VideoJobPayload.safeParse(job.payload);
  if (!parsed.success) throw new PermanentJobError(`invalid ${job.kind} payload`);
  return parsed.data;
}
