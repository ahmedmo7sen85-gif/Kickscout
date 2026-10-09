import type { Transaction } from 'kysely';
import type { DB } from '@fp/db';
import { shouldDeliver } from '@fp/domain';
import { newId } from './ids.js';

/**
 * Transactional outbox: events are written in the same transaction as the change they describe,
 * then relayed to the event bus. The relay to SNS/SQS is not built yet.
 */
export async function emit(tx: Transaction<DB>, topic: string, payload: Record<string, unknown>) {
  await tx.insertInto('outbox').values({ topic, payload: JSON.stringify(payload) }).execute();
}

/** Append-only audit trail for consent, safety, admin and data-access actions. */
export async function audit(
  tx: Transaction<DB>,
  entry: { actorId: string | null; action: string; targetKind?: string; targetId?: string; caseId?: string | null; metadata?: Record<string, unknown> },
) {
  await tx
    .insertInto('audit_logs')
    .values({
      actor_id: entry.actorId,
      action: entry.action,
      target_kind: entry.targetKind ?? null,
      target_id: entry.targetId ?? null,
      case_id: entry.caseId ?? null,
      metadata: JSON.stringify(entry.metadata ?? {}),
    })
    .execute();
}

/** Queues background work for the worker (see apps/worker). Written in the caller's transaction. */
export async function enqueue(tx: Transaction<DB>, kind: string, payload: Record<string, unknown>) {
  await tx.insertInto('jobs').values({ kind, payload: JSON.stringify(payload) }).execute();
}

/**
 * In-app notification, written in the caller's transaction. Skipped when the recipient turned the
 * kind's category off; security, safety and moderation notices are always delivered.
 */
export async function notify(tx: Transaction<DB>, userId: string, kind: string, payload: Record<string, unknown> = {}) {
  const prefs = await tx.selectFrom('notification_preferences').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (prefs && !shouldDeliver(kind, prefs)) return;
  await tx.insertInto('notifications').values({ id: newId(), user_id: userId, kind, payload: JSON.stringify(payload) }).execute();
}
