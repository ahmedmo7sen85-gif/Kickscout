import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '@fp/db';
import type { Deps } from '../../deps.js';
import { audit } from '../events.js';

/** Statuses the provider may still bill. */
const LIVE = ['incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused'] as const;

/** After this many failed provider attempts a row is left for a person to look at (it stays listed as pending). */
export const MAX_CANCEL_ATTEMPTS = 10;

/**
 * Closes, inside the deletion transaction, every live subscription the account holds or pays for
 * (a guardian paying for a ward included). The rows stop granting anything at once and are marked
 * as waiting for the provider, so a failed provider call is never forgotten.
 */
export async function closeSubscriptionsForDeletion(tx: Transaction<DB>, subjectId: string, actorId: string, now: Date): Promise<string[]> {
  const rows = await tx.selectFrom('subscriptions').select(['id', 'user_id', 'plan_key', 'status'])
    .where((eb) => eb.or([eb('user_id', '=', subjectId), eb('payer_user_id', '=', subjectId)]))
    .where('status', 'in', [...LIVE]).forUpdate().execute();
  for (const r of rows) {
    await tx.updateTable('subscriptions').set({
      status: 'canceled', canceled_at: now, cancel_at_period_end: false, cancel_requested_at: now, cancel_reason: 'account_deleted',
      // Provider events from before this moment can no longer reopen the row.
      provider_event_at: sql<Date>`greatest(provider_event_at, ${now})`, updated_at: now,
    }).where('id', '=', r.id).execute();
    await audit(tx, { actorId, action: 'billing.subscription_canceled', targetKind: 'user', targetId: r.user_id, metadata: { reason: 'account_deleted', planKey: r.plan_key, previousStatus: r.status, deletedUserId: subjectId } });
  }
  return rows.map((r) => r.id);
}

/**
 * Asks the provider to stop each subscription now. Success sets provider_canceled_at; failure keeps
 * the error and attempt count on the row and is audited, for retryPendingCancellations.
 */
export async function cancelAtProvider(deps: Deps, log: FastifyBaseLogger, ids: readonly string[]): Promise<{ canceled: number; failed: number }> {
  let canceled = 0;
  let failed = 0;
  if (!ids.length) return { canceled, failed };
  const rows = await deps.db.selectFrom('subscriptions').select(['id', 'user_id', 'plan_key', 'provider', 'provider_subscription_id'])
    .where('id', 'in', ids).where('provider_canceled_at', 'is', null).execute();
  for (const r of rows) {
    const billing = deps.billing;
    let error: string | null = null;
    if (!billing) error = 'billing not configured';
    else if (billing.name !== r.provider) error = `provider ${r.provider} not configured`;
    else {
      try {
        await billing.cancelSubscription(r.provider_subscription_id);
      } catch (err) {
        error = (err as Error).message.slice(0, 500) || 'provider error';
      }
    }
    const now = deps.now();
    await deps.db.transaction().execute(async (tx) => {
      if (error === null) {
        await tx.updateTable('subscriptions').set({ provider_canceled_at: now, provider_cancel_error: null, provider_cancel_attempts: sql`provider_cancel_attempts + 1`, updated_at: now })
          .where('id', '=', r.id).execute();
        await audit(tx, { actorId: null, action: 'billing.provider_canceled', targetKind: 'user', targetId: r.user_id, metadata: { planKey: r.plan_key } });
      } else {
        await tx.updateTable('subscriptions').set({ provider_cancel_error: error, provider_cancel_attempts: sql`provider_cancel_attempts + 1`, updated_at: now })
          .where('id', '=', r.id).execute();
        await audit(tx, { actorId: null, action: 'billing.provider_cancel_failed', targetKind: 'user', targetId: r.user_id, metadata: { planKey: r.plan_key, error } });
      }
    });
    if (error === null) canceled++;
    else {
      failed++;
      log.warn({ subscriptionId: r.id, error }, 'provider cancellation failed; will retry');
    }
  }
  return { canceled, failed };
}

/** Retries provider cancellations that have not gone through yet (oldest first, bounded batch). */
export async function retryPendingCancellations(deps: Deps, log: FastifyBaseLogger, limit = 20) {
  if (!deps.billing) return { canceled: 0, failed: 0, pending: await pendingCount(deps) };
  const ids = await deps.db.selectFrom('subscriptions').select('id')
    .where('cancel_requested_at', 'is not', null).where('provider_canceled_at', 'is', null)
    .where('provider_cancel_attempts', '<', MAX_CANCEL_ATTEMPTS)
    .orderBy('cancel_requested_at').limit(limit).execute();
  const r = await cancelAtProvider(deps, log, ids.map((x) => x.id));
  return { ...r, pending: await pendingCount(deps) };
}

async function pendingCount(deps: Deps): Promise<number> {
  const r = await deps.db.selectFrom('subscriptions').select(deps.db.fn.countAll<string>().as('n'))
    .where('cancel_requested_at', 'is not', null).where('provider_canceled_at', 'is', null).executeTakeFirstOrThrow();
  return Number(r.n);
}
