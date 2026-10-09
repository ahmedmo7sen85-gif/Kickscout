import { sql } from 'kysely';
import type { Database } from '@fp/db';

export interface JobRow {
  id: string;
  kind: string;
  payload: unknown;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  locked_at: Date | null;
  last_error: string | null;
}

export async function enqueue(db: Database, kind: string, payload: Record<string, unknown>, opts: { maxAttempts?: number } = {}) {
  const row = await db
    .insertInto('jobs')
    .values({ kind, payload: JSON.stringify(payload), ...(opts.maxAttempts ? { max_attempts: opts.maxAttempts } : {}) })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Atomically takes the oldest ready job. SKIP LOCKED means concurrent workers never take the same row. */
export async function claimJob(db: Database): Promise<JobRow | null> {
  const { rows } = await sql<JobRow>`
    UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs WHERE status = 'queued' AND run_after <= now()
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, kind, payload, status, attempts, max_attempts, run_after, locked_at, last_error`.execute(db);
  return rows[0] ?? null;
}

/** Keeps a long job from being mistaken for a crashed one. */
export async function heartbeat(db: Database, jobId: string) {
  await db.updateTable('jobs').set({ locked_at: sql`now()` }).where('id', '=', jobId).where('status', '=', 'running').execute();
}

export async function completeJob(db: Database, jobId: string) {
  await db
    .updateTable('jobs')
    .set({ status: 'done', finished_at: sql`now()`, locked_at: null })
    .where('id', '=', jobId)
    .where('status', '=', 'running')
    .execute();
}

/** Exponential backoff: base, 2x base, 4x base ... capped at one hour. */
export function backoffMs(attempts: number, baseMs: number) {
  return Math.min(baseMs * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

/**
 * Records a failed attempt. Returns 'retry' when the job went back to the queue, 'failed' when it is out of
 * attempts (or the error is permanent) and the caller must run the job's failure handling.
 */
export async function failJob(
  db: Database,
  job: Pick<JobRow, 'id' | 'attempts' | 'max_attempts'>,
  error: string,
  opts: { permanent: boolean; retryBaseMs: number },
): Promise<'retry' | 'failed'> {
  const message = error.slice(0, 2000);
  if (!opts.permanent && job.attempts < job.max_attempts) {
    const delay = backoffMs(job.attempts, opts.retryBaseMs);
    await db
      .updateTable('jobs')
      .set({ status: 'queued', locked_at: null, last_error: message, run_after: sql`now() + make_interval(secs => ${delay / 1000})` })
      .where('id', '=', job.id)
      .where('status', '=', 'running')
      .execute();
    return 'retry';
  }
  await db
    .updateTable('jobs')
    .set({ status: 'failed', locked_at: null, last_error: message, finished_at: sql`now()` })
    .where('id', '=', job.id)
    .where('status', '=', 'running')
    .execute();
  return 'failed';
}

/**
 * Jobs left `running` past the timeout belong to a worker that died (or hung). Those with attempts left go back
 * to the queue; those without are failed and returned so the caller can run their failure handling.
 */
export async function recoverStaleJobs(db: Database, timeoutMs: number): Promise<{ requeued: number; failed: JobRow[] }> {
  const cutoff = sql<Date>`now() - make_interval(secs => ${timeoutMs / 1000})`;
  const requeued = await db
    .updateTable('jobs')
    .set({ status: 'queued', locked_at: null, run_after: sql`now()`, last_error: 'timed out: worker stopped responding' })
    .where('status', '=', 'running')
    .where('locked_at', '<', cutoff)
    .where(sql<boolean>`attempts < max_attempts`)
    .executeTakeFirst();
  const { rows: failed } = await sql<JobRow>`
    UPDATE jobs SET status = 'failed', locked_at = NULL, finished_at = now(),
      last_error = 'timed out: worker stopped responding and no attempts are left'
    WHERE status = 'running' AND locked_at < ${cutoff} AND attempts >= max_attempts
    RETURNING id, kind, payload, status, attempts, max_attempts, run_after, locked_at, last_error`.execute(db);
  return { requeued: Number(requeued.numUpdatedRows), failed };
}

/** Queue depth for batch metrics: jobs waiting to run, running now, and failed for good in the last 24 hours. */
export async function queueDepth(db: Database): Promise<{ queued: number; running: number; failed24h: number }> {
  const row = await db.selectFrom('jobs')
    .select((eb) => [
      eb.fn.countAll<string>().filterWhere('status', '=', 'queued').as('queued'),
      eb.fn.countAll<string>().filterWhere('status', '=', 'running').as('running'),
      eb.fn.countAll<string>().filterWhere((w) => w.and([w('status', '=', 'failed'), w('finished_at', '>', new Date(Date.now() - 86_400_000))])).as('failed24h'),
    ])
    .executeTakeFirstOrThrow();
  return { queued: Number(row.queued), running: Number(row.running), failed24h: Number(row.failed24h) };
}
