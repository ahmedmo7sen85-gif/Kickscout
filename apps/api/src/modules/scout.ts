import { z } from 'zod';
import { sql } from 'kysely';
import {
  ContactRequestCreate, ContactRequestList, ContactResponseRequest, CreateScoutNoteRequest, CreateShortlistRequest, MarkReadRequest,
  CursorQuery, NotificationPage, PlayerPage, ScoutNoteList, ScoutNoteView, ScoutSearchQuery, ShortlistDetail, ShortlistList, ShortlistView,
  VerificationRequestCreate, VerificationRequestView,
} from '@fp/contracts';
import { isMinor } from '@fp/domain';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import { ApiError, conflict, forbidden, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { audit, notify } from '../platform/events.js';
import { ageBandOf, currentConsents } from '../platform/actor.js';
import { decodeCursor, encodeCursor } from '../platform/cursor.js';
import { discoverablePlayers, filterPlayers } from './catalog.js';
import { playerCards } from './views.js';

const Uuid = z.uuid();

async function ownShortlist(deps: Deps, ownerId: string, id: string | undefined) {
  const parsed = Uuid.safeParse(id);
  if (!parsed.success) throw notFound('shortlist');
  const s = await deps.db.selectFrom('shortlists').selectAll().where('id', '=', parsed.data).where('owner_id', '=', ownerId).executeTakeFirst();
  if (!s) throw notFound('shortlist');
  return s;
}

/** Only players a scout could find in search can be shortlisted, noted or contacted. */
async function discoverablePlayer(deps: Deps, ctx: { actor: import('@fp/domain').Actor | null }, id: string | undefined) {
  const parsed = Uuid.safeParse(id);
  if (!parsed.success) throw notFound('player');
  const row = await discoverablePlayers(deps, ctx.actor).select('users.id').where('users.id', '=', parsed.data).executeTakeFirst();
  if (!row) throw notFound('player');
  return row.id;
}

async function shortlistViews(deps: Deps, ownerId: string, id?: string) {
  let q = deps.db.selectFrom('shortlists').select((eb) => ['shortlists.id', 'shortlists.name', 'shortlists.created_at',
    eb.selectFrom('shortlist_players').select(eb.fn.countAll<string>().as('n')).whereRef('shortlist_players.shortlist_id', '=', 'shortlists.id').as('players')])
    .where('owner_id', '=', ownerId).orderBy('created_at', 'desc');
  if (id) q = q.where('shortlists.id', '=', id);
  return (await q.execute()).map((s) => ({ id: s.id, name: s.name, players: Number(s.players ?? 0), createdAt: s.created_at.toISOString() }));
}

export const scoutRoutes = [
  route(
    { method: 'get', path: '/v1/scout/players', summary: 'Scout search with filters', tag: 'scout', auth: 'user', query: ScoutSearchQuery, response: PlayerPage },
    async (ctx) => {
      ctx.authorize({ kind: 'scout.use' });
      const f = ctx.query;
      let q = filterPlayers(discoverablePlayers(ctx.deps, ctx.actor), f)
        .innerJoin('age_records', 'age_records.user_id', 'users.id')
        .select(['users.id', 'profiles.handle']);
      // A hidden age group cannot be found by filtering on it either.
      if (f.ageGroup) q = q.where('age_records.age_band', '=', f.ageGroup).where('privacy_settings.show_age', '=', true);
      if (f.verifiedOnly) q = q.where('profiles.verified_at', 'is not', null);
      if (f.minFollowers) {
        q = q.where((eb) => eb(eb.selectFrom('follows').select(eb.fn.countAll().as('n')).whereRef('followee_id', '=', 'users.id'), '>=', f.minFollowers!));
      }
      if (f.cursor) {
        // Cursor over handle order; the timestamp half is unused here.
        const c = decodeCursor(f.cursor);
        q = q.where(sql<boolean>`(profiles.handle::text, users.id) > (${c.id.length ? (await handleOf(ctx.deps, c.id)) : ''}, ${c.id}::uuid)`);
      }
      const rows = await q.orderBy(sql`profiles.handle::text`).orderBy('users.id').limit(f.limit + 1).execute();
      const page = rows.slice(0, f.limit);
      const last = page.at(-1);
      await ctx.deps.db.transaction().execute((tx) => audit(tx, { actorId: ctx.me().userId, action: 'scout.search', metadata: { filters: { ...f, cursor: undefined } } }));
      return {
        items: await playerCards(ctx.deps, ctx.actor, page.map((r) => r.id)),
        nextCursor: rows.length > f.limit && last ? encodeCursor(new Date(0), last.id) : null,
      };
    },
  ),

  route(
    { method: 'get', path: '/v1/scout/shortlists', summary: 'My shortlists', tag: 'scout', auth: 'user', response: ShortlistList },
    async (ctx) => {
      ctx.authorize({ kind: 'scout.use' });
      return { items: await shortlistViews(ctx.deps, ctx.me().userId) };
    },
  ),
  route(
    { method: 'post', path: '/v1/scout/shortlists', summary: 'Create a shortlist', tag: 'scout', auth: 'user', body: CreateShortlistRequest, response: ShortlistView, status: 201 },
    async (ctx) => {
      ctx.authorize({ kind: 'scout.use' });
      const id = newId();
      const me = ctx.me();
      const count = await ctx.deps.db.selectFrom('shortlists').select(ctx.deps.db.fn.countAll<string>().as('n')).where('owner_id', '=', me.userId).executeTakeFirstOrThrow();
      if (Number(count.n) >= 50) throw new ApiError(400, 'LIMIT_REACHED', 'you can have up to 50 shortlists');
      await ctx.deps.db.insertInto('shortlists').values({ id, owner_id: me.userId, name: ctx.body.name }).execute();
      return (await shortlistViews(ctx.deps, me.userId, id))[0]!;
    },
  ),
  route(
    { method: 'get', path: '/v1/scout/shortlists/:shortlistId', summary: 'A shortlist with its players', tag: 'scout', auth: 'user', response: ShortlistDetail },
    async (ctx) => {
      ctx.authorize({ kind: 'scout.use' });
      const me = ctx.me();
      const s = await ownShortlist(ctx.deps, me.userId, ctx.params.shortlistId);
      const members = await ctx.deps.db.selectFrom('shortlist_players').select(['player_id', 'added_at']).where('shortlist_id', '=', s.id).orderBy('added_at', 'desc').execute();
      // Players who since went private, were suspended or blocked the scout drop out of the view.
      const visible = new Set((await discoverablePlayers(ctx.deps, me).select('users.id').where('users.id', 'in', members.length ? members.map((m) => m.player_id) : [s.id]).execute()).map((r) => r.id));
      const ids = members.filter((m) => visible.has(m.player_id));
      const cards = new Map((await playerCards(ctx.deps, me, ids.map((m) => m.player_id))).map((c) => [c.userId, c]));
      return {
        ...(await shortlistViews(ctx.deps, me.userId, s.id))[0]!,
        items: ids.flatMap((m) => (cards.has(m.player_id) ? [{ ...cards.get(m.player_id)!, addedAt: m.added_at.toISOString() }] : [])),
      };
    },
  ),
  route(
    { method: 'delete', path: '/v1/scout/shortlists/:shortlistId', summary: 'Delete a shortlist', tag: 'scout', auth: 'user', status: 204 },
    async (ctx) => {
      ctx.authorize({ kind: 'scout.use' });
      const s = await ownShortlist(ctx.deps, ctx.me().userId, ctx.params.shortlistId);
      await ctx.deps.db.deleteFrom('shortlists').where('id', '=', s.id).execute();
    },
  ),
  route(
    { method: 'put', path: '/v1/scout/shortlists/:shortlistId/players/:playerId', summary: 'Add a player to a shortlist', tag: 'scout', auth: 'user', status: 204 },
    async (ctx) => {
      ctx.authorize({ kind: 'scout.use' });
      const s = await ownShortlist(ctx.deps, ctx.me().userId, ctx.params.shortlistId);
      const playerId = await discoverablePlayer(ctx.deps, ctx, ctx.params.playerId);
      await ctx.deps.db.insertInto('shortlist_players').values({ shortlist_id: s.id, player_id: playerId })
        .onConflict((oc) => oc.columns(['shortlist_id', 'player_id']).doNothing()).execute();
    },
  ),
  route(
    { method: 'delete', path: '/v1/scout/shortlists/:shortlistId/players/:playerId', summary: 'Remove a player from a shortlist', tag: 'scout', auth: 'user', status: 204 },
    async (ctx) => {
      ctx.authorize({ kind: 'scout.use' });
      const s = await ownShortlist(ctx.deps, ctx.me().userId, ctx.params.shortlistId);
      await ctx.deps.db.deleteFrom('shortlist_players').where('shortlist_id', '=', s.id).where('player_id', '=', Uuid.parse(ctx.params.playerId)).execute();
    },
  ),

  route(
    { method: 'get', path: '/v1/scout/players/:playerId/notes', summary: 'My private notes on a player', tag: 'scout', auth: 'user', response: ScoutNoteList },
    async (ctx) => {
      ctx.authorize({ kind: 'scout.use' });
      const rows = await ctx.deps.db.selectFrom('scout_notes').selectAll().where('scout_id', '=', ctx.me().userId)
        .where('player_id', '=', Uuid.parse(ctx.params.playerId)).orderBy('created_at', 'desc').execute();
      return { items: rows.map((n) => ({ id: n.id, playerId: n.player_id, body: n.body, createdAt: n.created_at.toISOString(), updatedAt: n.updated_at.toISOString() })) };
    },
  ),
  route(
    { method: 'post', path: '/v1/scout/players/:playerId/notes', summary: 'Add a private note on a player', tag: 'scout', auth: 'user', body: CreateScoutNoteRequest, response: ScoutNoteView, status: 201 },
    async (ctx) => {
      ctx.authorize({ kind: 'scout.use' });
      const playerId = await discoverablePlayer(ctx.deps, ctx, ctx.params.playerId);
      const n = await ctx.deps.db.insertInto('scout_notes').values({ id: newId(), scout_id: ctx.me().userId, player_id: playerId, body: ctx.body.body })
        .returningAll().executeTakeFirstOrThrow();
      return { id: n.id, playerId: n.player_id, body: n.body, createdAt: n.created_at.toISOString(), updatedAt: n.updated_at.toISOString() };
    },
  ),
  route(
    { method: 'delete', path: '/v1/scout/notes/:noteId', summary: 'Delete one of my notes', tag: 'scout', auth: 'user', status: 204 },
    async (ctx) => {
      ctx.authorize({ kind: 'scout.use' });
      const res = await ctx.deps.db.deleteFrom('scout_notes').where('id', '=', Uuid.parse(ctx.params.noteId)).where('scout_id', '=', ctx.me().userId).executeTakeFirst();
      if (res.numDeletedRows === 0n) throw notFound('note');
    },
  ),

  route(
    { method: 'post', path: '/v1/scout/players/:playerId/contact', summary: 'Ask to contact a player (goes to the guardian for a minor)', tag: 'scout', auth: 'user', body: ContactRequestCreate, status: 202, rateLimit: { max: 20, timeWindow: '1 day' } },
    async (ctx) => {
      const me = ctx.me();
      ctx.authorize({ kind: 'scout.use' });
      const playerId = await discoverablePlayer(ctx.deps, ctx, ctx.params.playerId);
      const [consents, privacy] = await Promise.all([
        currentConsents(ctx.deps.db, playerId),
        ctx.deps.db.selectFrom('privacy_settings').select('allow_contact_requests').where('user_id', '=', playerId).executeTakeFirst(),
      ]);
      // Both must hold: the scout-contact consent (the guardian's, for a minor) and the player's own contact toggle.
      ctx.authorize({ kind: 'scout.contact', playerId, playerAcceptsContact: consents.has('scout_contact') && privacy?.allow_contact_requests === true });
      const band = await ageBandOf(ctx.deps.db, playerId);
      let routedTo = playerId;
      if (!band || isMinor(band)) {
        const g = await ctx.deps.db.selectFrom('guardian_relationships').select('guardian_user_id').where('minor_user_id', '=', playerId)
          .where('status', '=', 'active').orderBy('created_at').executeTakeFirst();
        if (!g) throw forbidden('CONTACT_NOT_ALLOWED', 'this player does not accept scout contact');
        routedTo = g.guardian_user_id;
      }
      await ctx.deps.db.transaction().execute(async (tx) => {
        const id = newId();
        const res = await tx.insertInto('contact_requests').values({ id, scout_id: me.userId, player_id: playerId, routed_to: routedTo, message: ctx.body.message })
          .onConflict((oc) => oc.columns(['scout_id', 'player_id']).where('status', '=', 'pending').doNothing()).returning('id').executeTakeFirst();
        if (!res) throw conflict('ALREADY_REQUESTED', 'you already have a pending request for this player');
        await notify(tx, routedTo, 'contact.requested', { requestId: id, playerId });
        await audit(tx, { actorId: me.userId, action: 'scout.contact_requested', targetKind: 'user', targetId: playerId, metadata: { requestId: id, viaGuardian: routedTo !== playerId } });
      });
    },
  ),

  route(
    { method: 'get', path: '/v1/contact-requests', summary: 'Contact requests sent to me (or my ward), or sent by me as a scout', tag: 'scout', auth: 'user', query: z.object({ direction: z.enum(['incoming', 'outgoing']).default('incoming') }), response: ContactRequestList },
    async (ctx) => {
      const me = ctx.me();
      let q = ctx.deps.db.selectFrom('contact_requests')
        .innerJoin('profiles as sp', 'sp.user_id', 'contact_requests.scout_id')
        .innerJoin('profiles as pp', 'pp.user_id', 'contact_requests.player_id')
        .select((eb) => ['contact_requests.id', 'contact_requests.scout_id', 'contact_requests.player_id', 'contact_requests.routed_to',
          'contact_requests.message', 'contact_requests.status', 'contact_requests.created_at', 'sp.handle as scout_handle',
          'sp.display_name as scout_name', 'pp.handle as player_handle',
          eb.selectFrom('verification_requests').select('organization').whereRef('verification_requests.user_id', '=', 'contact_requests.scout_id')
            .where('kind', '=', 'scout').where('status', '=', 'approved').orderBy('decided_at', 'desc').limit(1).as('organization')])
        .orderBy('contact_requests.created_at', 'desc').limit(100);
      q = ctx.query.direction === 'incoming' ? q.where('contact_requests.routed_to', '=', me.userId) : q.where('contact_requests.scout_id', '=', me.userId);
      const rows = await q.execute();
      return {
        items: rows.map((r) => ({
          id: r.id, scout: { userId: r.scout_id, handle: r.scout_handle, displayName: r.scout_name, organization: r.organization ?? null },
          player: { userId: r.player_id, handle: r.player_handle }, viaGuardian: r.routed_to !== r.player_id, message: r.message,
          status: r.status as never, createdAt: r.created_at.toISOString(),
        })),
      };
    },
  ),
  route(
    { method: 'post', path: '/v1/contact-requests/:requestId/respond', summary: 'Accept or decline a scout’s contact request', tag: 'scout', auth: 'user', body: ContactResponseRequest, status: 204 },
    async (ctx) => {
      const me = ctx.me();
      await ctx.deps.db.transaction().execute(async (tx) => {
        const r = await tx.selectFrom('contact_requests').selectAll().where('id', '=', Uuid.parse(ctx.params.requestId)).forUpdate().executeTakeFirst();
        // Only the person the request was routed to (the player, or a minor's guardian) can answer.
        if (!r || r.routed_to !== me.userId) throw notFound('contact request');
        if (r.status !== 'pending') throw conflict('ALREADY_ANSWERED', 'this request is already answered');
        const status = ctx.body.accept ? 'accepted' : 'declined';
        await tx.updateTable('contact_requests').set({ status, responded_at: ctx.deps.now() }).where('id', '=', r.id).execute();
        await notify(tx, r.scout_id, `contact.${status}`, { requestId: r.id, playerId: r.player_id });
        await audit(tx, { actorId: me.userId, action: `scout.contact_${status}`, targetKind: 'user', targetId: r.player_id, metadata: { requestId: r.id } });
      });
    },
  ),

  route(
    { method: 'post', path: '/v1/verification-requests', summary: 'Apply for player or scout verification', tag: 'verification', auth: 'user', body: VerificationRequestCreate, response: VerificationRequestView, status: 201, rateLimit: { max: 5, timeWindow: '1 day' } },
    async (ctx) => {
      const me = ctx.me();
      const b = ctx.body;
      if (b.kind === 'player' && !me.roles.includes('player')) throw forbidden('ROLE_REQUIRED', 'only players can apply for player verification');
      if (b.kind === 'scout' && isMinor(me.ageBand)) throw forbidden('ADULTS_ONLY', 'scouts must be adults');
      if (b.kind === 'scout' && !b.organization) throw new ApiError(400, 'ORGANIZATION_REQUIRED', 'tell us which club, academy or agency you scout for');
      const id = newId();
      const profile = await ctx.deps.db.selectFrom('profiles').select(['handle', 'display_name']).where('user_id', '=', me.userId).executeTakeFirstOrThrow();
      const created = await ctx.deps.db.transaction().execute(async (tx) => {
        const res = await tx.insertInto('verification_requests').values({ id, user_id: me.userId, kind: b.kind, organization: b.organization ?? null, evidence: b.evidence })
          .onConflict((oc) => oc.columns(['user_id', 'kind']).where('status', '=', 'pending').doNothing()).returning('created_at').executeTakeFirst();
        if (!res) throw conflict('ALREADY_PENDING', 'you already have a pending request');
        await audit(tx, { actorId: me.userId, action: 'verification.requested', targetKind: 'user', targetId: me.userId, metadata: { kind: b.kind } });
        return res;
      });
      return {
        id, user: { userId: me.userId, handle: profile.handle, displayName: profile.display_name }, kind: b.kind, status: 'pending' as const,
        organization: b.organization ?? null, evidence: b.evidence, createdAt: created.created_at.toISOString(),
      };
    },
  ),

  route(
    { method: 'get', path: '/v1/notifications', summary: 'My notifications', tag: 'notifications', auth: 'user', query: CursorQuery, response: NotificationPage },
    async (ctx) => {
      const me = ctx.me();
      let q = ctx.deps.db.selectFrom('notifications').selectAll().where('user_id', '=', me.userId);
      if (ctx.query.cursor) {
        const c = decodeCursor(ctx.query.cursor);
        q = q.where(sql<boolean>`(created_at, id) < (${c.at}, ${c.id}::uuid)`);
      }
      const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(ctx.query.limit + 1).execute();
      const items = rows.slice(0, ctx.query.limit);
      const last = items.at(-1);
      return {
        items: items.map((n) => ({ id: n.id, kind: n.kind, payload: n.payload as Record<string, unknown>, read: n.read_at !== null, createdAt: n.created_at.toISOString() })),
        nextCursor: rows.length > ctx.query.limit && last ? encodeCursor(last.created_at, last.id) : null,
      };
    },
  ),
  route(
    { method: 'post', path: '/v1/notifications/read', summary: 'Mark notifications read (all when no ids are given)', tag: 'notifications', auth: 'user', body: MarkReadRequest, status: 204 },
    async (ctx) => {
      let q = ctx.deps.db.updateTable('notifications').set({ read_at: ctx.deps.now() }).where('user_id', '=', ctx.me().userId).where('read_at', 'is', null);
      if (ctx.body.ids?.length) q = q.where('id', 'in', ctx.body.ids);
      await q.execute();
    },
  ),
];

async function handleOf(deps: Deps, userId: string) {
  return (await deps.db.selectFrom('profiles').select('handle').where('user_id', '=', userId).executeTakeFirst())?.handle ?? '';
}
