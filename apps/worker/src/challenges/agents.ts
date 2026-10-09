/**
 * The standard record every challenge agent writes: one `challenge_agent_runs` row and one
 * structured log line per run, with agent, version, provider/model (null for rule-based agents),
 * latency, outcome, confidence, cost and a trace id. Admin metrics and the cost-spike check read it.
 */
import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@fp/db';
import { CHALLENGE_AGENT_VERSION, shouldDeliver } from '@fp/domain';
import type { ChallengeNoticeKind } from '@fp/domain';
import { CHALLENGE_NOTICES, noticeAllowed } from '@fp/domain';
import { v7 as uuidv7 } from 'uuid';
import type { Logger } from '../pipeline.js';

export type Conn = Kysely<DB> | Transaction<DB>;

export type ChallengeAgent = 'recommendation' | 'verification' | 'scoring' | 'anti_fraud' | 'seo' | 'operations' | 'notification';
export type AgentOutcome = 'ok' | 'routed_to_human' | 'flagged' | 'skipped' | 'error';

export interface AgentRun {
  agent: ChallengeAgent;
  outcome: AgentOutcome;
  latencyMs: number;
  traceId?: string;
  provider?: string | null;
  model?: string | null;
  confidence?: number | null;
  costUsdMicros?: number;
  subjectKind?: string | null;
  subjectId?: string | null;
  detail?: Record<string, unknown>;
}

export const newTraceId = () => randomUUID().replace(/-/g, '');

/** Never throws: losing a log row must not undo the work it describes. */
export async function recordAgentRun(db: Conn, log: Logger | null, run: AgentRun): Promise<void> {
  const traceId = run.traceId ?? newTraceId();
  const row = {
    agent: run.agent, agent_version: CHALLENGE_AGENT_VERSION, provider: run.provider ?? null, model: run.model ?? null,
    latency_ms: Math.max(0, Math.round(run.latencyMs)), outcome: run.outcome, confidence: run.confidence ?? null,
    cost_usd_micros: run.costUsdMicros ?? 0, trace_id: traceId, subject_kind: run.subjectKind ?? null, subject_id: run.subjectId ?? null,
    detail: JSON.stringify(run.detail ?? {}),
  };
  log?.[run.outcome === 'error' ? 'error' : 'info']('challenge agent run', { ...row, detail: run.detail ?? {} });
  try {
    await db.insertInto('challenge_agent_runs').values(row).execute();
  } catch (err) {
    log?.warn('could not record agent run', { agent: run.agent, traceId, error: (err as Error).message });
  }
}

/** Times `fn` and records its outcome; an exception is recorded as `error` and re-thrown. */
export async function runAgent<T>(
  db: Conn, log: Logger | null, agent: ChallengeAgent, subject: { kind?: string; id?: string | null },
  fn: () => Promise<{ outcome: AgentOutcome; value: T; detail?: Record<string, unknown>; confidence?: number | null }>,
): Promise<T> {
  const started = performance.now();
  const traceId = newTraceId();
  try {
    const r = await fn();
    await recordAgentRun(db, log, { agent, outcome: r.outcome, latencyMs: performance.now() - started, traceId, subjectKind: subject.kind ?? null, subjectId: subject.id ?? null, detail: r.detail ?? {}, confidence: r.confidence ?? null });
    return r.value;
  } catch (err) {
    await recordAgentRun(db, log, { agent, outcome: 'error', latencyMs: performance.now() - started, traceId, subjectKind: subject.kind ?? null, subjectId: subject.id ?? null, detail: { error: (err as Error).message.slice(0, 300) } });
    throw err;
  }
}

// ---------------------------------------------------------------- Notification Agent

export interface ChallengeNotice {
  userId: string;
  kind: ChallengeNoticeKind;
  /** Same key, same person: sent once, however often a job retries. */
  dedupeKey: string;
  payload: Record<string, unknown>;
}

const OPTIONAL_KINDS = Object.entries(CHALLENGE_NOTICES).filter(([, v]) => v === 'optional').map(([k]) => k);

async function deliver(tx: Transaction<DB>, n: ChallengeNotice): Promise<'sent' | 'suppressed' | 'duplicate'> {
  const claimed = await tx.insertInto('challenge_notifications').values({ user_id: n.userId, dedupe_key: n.dedupeKey, kind: n.kind })
    .onConflict((oc) => oc.columns(['user_id', 'dedupe_key']).doNothing()).returning('user_id').executeTakeFirst();
  if (!claimed) return 'duplicate';
  const prefs = await tx.selectFrom('notification_preferences').selectAll().where('user_id', '=', n.userId).executeTakeFirst();
  if (prefs && !shouldDeliver(n.kind, prefs)) return 'suppressed';
  if (CHALLENGE_NOTICES[n.kind] === 'optional') {
    const today = await tx.selectFrom('challenge_notifications').select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', n.userId).where('kind', 'in', OPTIONAL_KINDS).where('notification_id', 'is not', null)
      .where('created_at', '>', new Date(Date.now() - 86_400_000)).executeTakeFirstOrThrow();
    if (!noticeAllowed(n.kind, Number(today.n))) return 'suppressed';
  }
  const id = uuidv7();
  await tx.insertInto('notifications').values({ id, user_id: n.userId, kind: n.kind, payload: JSON.stringify(n.payload) }).execute();
  await tx.updateTable('challenge_notifications').set({ notification_id: id }).where('user_id', '=', n.userId).where('dedupe_key', '=', n.dedupeKey).execute();
  return 'sent';
}

/**
 * Sends one in-app challenge notice: idempotent by dedupe key, respects the person's challenge
 * notification setting, and caps optional reminders per day. Runs inside the caller's transaction
 * when given one, so a notice never outlives a rolled-back result (and is never lost to one).
 */
export async function sendChallengeNotice(db: Conn, n: ChallengeNotice): Promise<'sent' | 'suppressed' | 'duplicate'> {
  if (db.isTransaction) return deliver(db as Transaction<DB>, n);
  return (db as Kysely<DB>).transaction().execute((tx) => deliver(tx, n));
}
