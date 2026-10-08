import type { Transaction } from 'kysely';
import type { DB } from '@fp/db';
import { can, isMinor } from '@fp/domain';
import type { Action, Actor } from '@fp/domain';
import type { Deps } from '../deps.js';
import { ApiError, conflict, forbidden, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { audit, notify } from '../platform/events.js';
import { ageBandOf, currentConsents } from '../platform/actor.js';
import { discoverablePlayers } from './catalog.js';

function authorize(actor: Actor, action: Action) {
  const d = can(actor, action);
  if (!d.allowed) throw new ApiError(403, d.code, d.reason);
}

/**
 * The one way a scout asks to contact a player, used by the scout contact route and by the CRM's
 * Contact Requested stage. Enforces, in order: verified scout; the player is discoverable to this
 * scout (public, scout discovery on, not blocked); the scout-contact consent (the guardian's, for a
 * minor) and the player's own contact toggle; a minor's request goes to their active guardian, and
 * without one it is refused. Written in `tx` when given, so a caller can make it part of a larger change.
 */
export async function sendContactRequest(
  deps: Deps,
  me: Actor,
  playerId: string,
  message: string,
  opts: { organizationId?: string | null; tx?: Transaction<DB> } = {},
): Promise<{ id: string; routedTo: string }> {
  authorize(me, { kind: 'scout.use' });
  const visible = await discoverablePlayers(deps, me).select('users.id').where('users.id', '=', playerId).executeTakeFirst();
  if (!visible) throw notFound('player');
  const [consents, privacy] = await Promise.all([
    currentConsents(deps.db, playerId),
    deps.db.selectFrom('privacy_settings').select('allow_contact_requests').where('user_id', '=', playerId).executeTakeFirst(),
  ]);
  // Both must hold: the scout-contact consent (the guardian's, for a minor) and the player's own contact toggle.
  authorize(me, { kind: 'scout.contact', playerId, playerAcceptsContact: consents.has('scout_contact') && privacy?.allow_contact_requests === true });
  const band = await ageBandOf(deps.db, playerId);
  let routedTo = playerId;
  if (!band || isMinor(band)) {
    const g = await deps.db.selectFrom('guardian_relationships').select('guardian_user_id').where('minor_user_id', '=', playerId)
      .where('status', '=', 'active').orderBy('created_at').executeTakeFirst();
    if (!g) throw forbidden('CONTACT_NOT_ALLOWED', 'this player does not accept scout contact');
    routedTo = g.guardian_user_id;
  }
  const write = async (tx: Transaction<DB>) => {
    const id = newId();
    const res = await tx.insertInto('contact_requests').values({
      id, scout_id: me.userId, player_id: playerId, routed_to: routedTo, message, organization_id: opts.organizationId ?? null,
    }).onConflict((oc) => oc.columns(['scout_id', 'player_id']).where('status', '=', 'pending').doNothing()).returning('id').executeTakeFirst();
    if (!res) throw conflict('ALREADY_REQUESTED', 'you already have a pending request for this player');
    await notify(tx, routedTo, 'contact.requested', { requestId: id, playerId });
    await audit(tx, {
      actorId: me.userId, action: 'scout.contact_requested', targetKind: 'user', targetId: playerId,
      metadata: { requestId: id, viaGuardian: routedTo !== playerId, organizationId: opts.organizationId ?? null },
    });
    return { id, routedTo };
  };
  return opts.tx ? write(opts.tx) : deps.db.transaction().execute(write);
}
