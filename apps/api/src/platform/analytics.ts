import { createHmac } from 'node:crypto';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import type { DB } from '@fp/db';
import type { AnalyticsEventName, AnalyticsProps } from '@fp/contracts';
import { isMinor } from '@fp/domain';
import type { Actor } from '@fp/domain';
import { recordServerEvent } from '@fp/worker/analytics';
import type { EventSubject } from '@fp/worker/analytics';
import type { Deps } from '../deps.js';

/**
 * Signed-out callers are counted by a keyed hash of IP and user agent that changes every UTC day:
 * no raw IP is stored, and nobody can be followed from one day to the next.
 */
export function anonymousId(deps: Deps, req: FastifyRequest): string {
  const day = deps.now().toISOString().slice(0, 10);
  return createHmac('sha256', deps.config.VIEWER_HASH_SECRET)
    .update(`analytics|${day}|${req.ip}|${req.headers['user-agent'] ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

/** Global Privacy Control or Do Not Track: a signed-out browser asking not to be tracked gets only necessary events. */
export function browserOptsOut(req: FastifyRequest): boolean {
  return req.headers['sec-gpc'] === '1' || req.headers.dnt === '1';
}

/** A short keyed hash of a user id for logs: correlates one person's requests without logging the id. */
export function userHash(deps: Pick<Deps, 'config'>, userId: string): string {
  return createHmac('sha256', deps.config.VIEWER_HASH_SECRET).update(`log|${userId}`).digest('hex').slice(0, 16);
}

export type TrackSubject =
  | { actor: Actor | null; req: FastifyRequest }
  | { userId: string; minor?: boolean };

/**
 * Records a server-side analytics event. The registry in @fp/contracts decides what is kept (the
 * person's analytics preference, minors' identifying properties). Never throws: a failure is
 * logged and the action it describes carries on. Pass `tx` to record it atomically with a change.
 */
export async function track<N extends AnalyticsEventName>(
  deps: Deps,
  log: FastifyBaseLogger,
  name: N,
  properties: AnalyticsProps<N>,
  who: TrackSubject,
  tx?: Transaction<DB>,
): Promise<void> {
  let subject: EventSubject;
  if ('userId' in who) subject = { userId: who.userId, minor: who.minor };
  else if (who.actor) subject = { userId: who.actor.userId, minor: isMinor(who.actor.ageBand) };
  else subject = { anonId: anonymousId(deps, who.req), optedOut: browserOptsOut(who.req), minor: false };
  try {
    await recordServerEvent(tx ?? deps.db, name, properties, subject);
  } catch (err) {
    log.warn({ err, event: name }, 'analytics event not recorded');
  }
}
