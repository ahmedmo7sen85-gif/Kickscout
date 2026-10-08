/**
 * Scout CRM: a recruitment pipeline per owner scope, either a verified scout's own
 * (`/v1/scout/crm/...`) or an organization's (`/v1/orgs/:orgId/crm/...`). The same handlers serve
 * both; the scope decides whose rows are visible. Nothing here is ever shown to the player.
 *
 * Organization roles: viewer reads, analyst reads and writes notes, scout and above run the
 * pipeline (and must also be verified scouts), see packages/domain/src/orgs.ts.
 */
import { z } from 'zod';
import type { Selectable, Transaction } from 'kysely';
import type { DB } from '@fp/db';
import {
  AddToPipelineRequest, CreateCrmNoteRequest, CreateSavedSearchRequest, CrmEntryDetail, CrmEntryView, CrmNoteView, CrmStageChangeRequest,
  PipelineQuery, PipelineView, SavedSearchList, SavedSearchView, UpdateCrmEntryRequest, UpdateSavedSearchRequest,
} from '@fp/contracts';
import { CRM_STAGES, normaliseTags, stageMove } from '@fp/domain';
import type { Actor, CrmStage, OrgAction, OrgRole } from '@fp/domain';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import type { Ctx } from '../platform/route.js';
import { ApiError, conflict, forbidden, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { audit } from '../platform/events.js';
import { discoverablePlayers } from './catalog.js';
import { playerCards } from './views.js';
import { orgForAction } from './orgs.js';
import { sendContactRequest } from './contact-flow.js';

const Uuid = z.uuid();
const MAX_ENTRIES = 2000;
const MAX_SAVED_SEARCHES = 50;

export type CrmScope =
  | { kind: 'personal'; ownerUserId: string; role: 'owner' }
  | { kind: 'org'; orgId: string; role: OrgRole };

type ScopeKind = CrmScope['kind'];
type AnyCtx = Ctx<any, any>;
type EntryRow = Selectable<DB['crm_entries']>;

/** Resolves the caller's scope and checks `action` in it. Personal pipelines belong to verified scouts. */
async function scopeFor(ctx: AnyCtx, kind: ScopeKind, action: OrgAction): Promise<CrmScope> {
  if (kind === 'personal') {
    ctx.authorize({ kind: 'scout.use' });
    return { kind: 'personal', ownerUserId: ctx.me().userId, role: 'owner' };
  }
  const { org, role } = await orgForAction(ctx, ctx.params.orgId, action);
  return { kind: 'org', orgId: org.id, role };
}

const ownerColumns = (s: CrmScope) => (s.kind === 'personal'
  ? { owner_user_id: s.ownerUserId, organization_id: null }
  : { owner_user_id: null, organization_id: s.orgId });
const scopeLabel = (s: CrmScope) => (s.kind === 'personal' ? { scope: 'personal' } : { scope: 'organization', organizationId: s.orgId });

function entriesIn(db: Deps['db'] | Transaction<DB>, s: CrmScope) {
  const q = db.selectFrom('crm_entries');
  return s.kind === 'personal' ? q.where('crm_entries.owner_user_id', '=', s.ownerUserId) : q.where('crm_entries.organization_id', '=', s.orgId);
}

function searchesIn(db: Deps['db'] | Transaction<DB>, s: CrmScope) {
  const q = db.selectFrom('saved_searches');
  return s.kind === 'personal' ? q.where('saved_searches.owner_user_id', '=', s.ownerUserId) : q.where('saved_searches.organization_id', '=', s.orgId);
}

async function entryIn(db: Deps['db'] | Transaction<DB>, s: CrmScope, id: string | undefined, lock = false) {
  const parsed = Uuid.safeParse(id);
  if (!parsed.success) throw notFound('pipeline card');
  let q = entriesIn(db, s).selectAll().where('crm_entries.id', '=', parsed.data);
  if (lock) q = q.forUpdate();
  const e = await q.executeTakeFirst();
  if (!e) throw notFound('pipeline card');
  return e;
}

/** Players this viewer may still work with: the same rule as scout search (public, discoverable, not blocked). */
async function visiblePlayers(deps: Deps, viewer: Actor, ids: string[]) {
  if (!ids.length) return new Set<string>();
  return new Set((await discoverablePlayers(deps, viewer).select('users.id').where('users.id', 'in', ids).execute()).map((r) => r.id));
}

async function entryViews(deps: Deps, viewer: Actor, rows: EntryRow[]): Promise<z.input<typeof CrmEntryView>[]> {
  // A player who went private, turned off scout discovery, was suspended or blocked the viewer drops out of the pipeline.
  const visible = await visiblePlayers(deps, viewer, [...new Set(rows.map((r) => r.player_id))]);
  const shown = rows.filter((r) => visible.has(r.player_id));
  const requestIds = shown.flatMap((r) => (r.contact_request_id ? [r.contact_request_id] : []));
  const [cards, requests] = await Promise.all([
    playerCards(deps, viewer, [...new Set(shown.map((r) => r.player_id))]),
    requestIds.length
      ? deps.db.selectFrom('contact_requests').select(['id', 'status', 'routed_to', 'player_id']).where('id', 'in', requestIds).execute()
      : Promise.resolve([]),
  ]);
  const cardMap = new Map(cards.map((c) => [c.userId, c]));
  const reqMap = new Map(requests.map((r) => [r.id, r]));
  return shown.flatMap((r) => {
    const player = cardMap.get(r.player_id);
    if (!player) return [];
    const req = r.contact_request_id ? reqMap.get(r.contact_request_id) : undefined;
    return [{
      id: r.id, player, stage: r.stage as CrmStage, tags: r.tags,
      contactRequest: req ? { id: req.id, status: req.status as never, viaGuardian: req.routed_to !== req.player_id } : null,
      createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    }];
  });
}

async function entryView(deps: Deps, viewer: Actor, row: EntryRow) {
  const [view] = await entryViews(deps, viewer, [row]);
  if (!view) throw notFound('pipeline card');
  return view;
}

async function recordStage(tx: Transaction<DB>, s: CrmScope, actorId: string, e: { id: string; player_id: string }, from: string | null, to: string, extra: Record<string, unknown> = {}) {
  await tx.insertInto('crm_stage_history').values({ id: newId(), entry_id: e.id, from_stage: from, to_stage: to, changed_by: actorId }).execute();
  await audit(tx, {
    actorId, action: 'crm.stage_changed', targetKind: 'crm_entry', targetId: e.id,
    metadata: { ...scopeLabel(s), playerId: e.player_id, from, to, ...extra },
  });
}

async function savedSearchViews(deps: Deps, s: CrmScope, id?: string): Promise<z.input<typeof SavedSearchView>[]> {
  let q = searchesIn(deps.db, s).leftJoin('profiles', 'profiles.user_id', 'saved_searches.created_by')
    .select((eb) => ['saved_searches.id', 'saved_searches.name', 'saved_searches.filters', 'saved_searches.alerts_enabled', 'saved_searches.created_at',
      'saved_searches.created_by', 'profiles.handle',
      eb.selectFrom('saved_search_hits').select(eb.fn.countAll<string>().as('n')).whereRef('saved_search_hits.saved_search_id', '=', 'saved_searches.id').as('matches')])
    .orderBy('saved_searches.created_at', 'desc');
  if (id) q = q.where('saved_searches.id', '=', id);
  return (await q.execute()).map((r) => ({
    id: r.id, name: r.name, filters: r.filters as Record<string, unknown>, alerts: r.alerts_enabled, matches: Number(r.matches ?? 0),
    createdBy: r.handle ? { userId: r.created_by, handle: r.handle } : null, createdAt: r.created_at.toISOString(),
  }));
}

async function savedSearchIn(deps: Deps, s: CrmScope, id: string | undefined) {
  const parsed = Uuid.safeParse(id);
  if (!parsed.success) throw notFound('saved search');
  const row = await searchesIn(deps.db, s).selectAll().where('saved_searches.id', '=', parsed.data).executeTakeFirst();
  if (!row) throw notFound('saved search');
  return row;
}

function buildCrmRoutes(prefix: string, kind: ScopeKind) {
  const tag = kind === 'personal' ? 'scout' : 'organizations';
  const whose = kind === 'personal' ? 'my' : 'the organization’s';
  return [
    route(
      { method: 'get', path: `${prefix}/pipeline`, summary: `The ${kind === 'personal' ? 'scout’s' : 'organization’s'} pipeline, by stage`, tag, auth: 'user', query: PipelineQuery, response: PipelineView },
      async (ctx) => {
        const s = await scopeFor(ctx, kind, 'org.read');
        let q = entriesIn(ctx.deps.db, s).selectAll().orderBy('crm_entries.updated_at', 'desc').limit(MAX_ENTRIES);
        if (ctx.query.stage) q = q.where('crm_entries.stage', '=', ctx.query.stage);
        if (ctx.query.tag) q = q.where((eb) => eb(eb.val(ctx.query.tag!.trim().toLowerCase()), '=', eb.fn.any('crm_entries.tags')));
        return { stages: [...CRM_STAGES], items: await entryViews(ctx.deps, ctx.me(), await q.execute()) };
      },
    ),

    route(
      { method: 'put', path: `${prefix}/players/:playerId`, summary: `Add a player to ${whose} pipeline (returns the existing card if there is one)`, tag, auth: 'user', body: AddToPipelineRequest, response: CrmEntryView },
      async (ctx) => {
        const s = await scopeFor(ctx, kind, 'crm.write');
        const me = ctx.me();
        const playerId = Uuid.safeParse(ctx.params.playerId);
        // Only players a scout could find in search can be put in a pipeline.
        if (!playerId.success || !(await visiblePlayers(ctx.deps, me, [playerId.data])).has(playerId.data)) throw notFound('player');
        const existing = await entriesIn(ctx.deps.db, s).selectAll().where('crm_entries.player_id', '=', playerId.data).executeTakeFirst();
        if (existing) return entryView(ctx.deps, me, existing);
        const count = await entriesIn(ctx.deps.db, s).select(ctx.deps.db.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
        if (Number(count.n) >= MAX_ENTRIES) throw new ApiError(400, 'LIMIT_REACHED', `a pipeline can hold up to ${MAX_ENTRIES} players`);
        const row = await ctx.deps.db.transaction().execute(async (tx) => {
          const e = await tx.insertInto('crm_entries').values({
            id: newId(), ...ownerColumns(s), player_id: playerId.data, stage: ctx.body.stage, tags: normaliseTags(ctx.body.tags), created_by: me.userId,
          }).onConflict((oc) => oc.doNothing()).returningAll().executeTakeFirst();
          if (!e) return undefined;
          await recordStage(tx, s, me.userId, e, null, e.stage);
          return e;
        });
        // Lost a race with another member adding the same player: return their card.
        return entryView(ctx.deps, me, row ?? (await entriesIn(ctx.deps.db, s).selectAll().where('crm_entries.player_id', '=', playerId.data).executeTakeFirstOrThrow()));
      },
    ),

    route(
      { method: 'get', path: `${prefix}/entries/:entryId`, summary: 'A pipeline card with its stage history and notes', tag, auth: 'user', response: CrmEntryDetail },
      async (ctx) => {
        const s = await scopeFor(ctx, kind, 'org.read');
        const e = await entryIn(ctx.deps.db, s, ctx.params.entryId);
        const view = await entryView(ctx.deps, ctx.me(), e);
        const [history, notes] = await Promise.all([
          ctx.deps.db.selectFrom('crm_stage_history').leftJoin('profiles', 'profiles.user_id', 'crm_stage_history.changed_by')
            .select(['crm_stage_history.from_stage', 'crm_stage_history.to_stage', 'crm_stage_history.changed_by', 'crm_stage_history.created_at', 'profiles.handle'])
            .where('crm_stage_history.entry_id', '=', e.id).orderBy('crm_stage_history.created_at').orderBy('crm_stage_history.id').execute(),
          ctx.deps.db.selectFrom('crm_notes').leftJoin('profiles', 'profiles.user_id', 'crm_notes.author_id')
            .select(['crm_notes.id', 'crm_notes.body', 'crm_notes.author_id', 'crm_notes.created_at', 'profiles.handle'])
            .where('crm_notes.entry_id', '=', e.id).orderBy('crm_notes.created_at', 'desc').execute(),
        ]);
        return {
          ...view,
          history: history.map((h) => ({
            from: h.from_stage as CrmStage | null, to: h.to_stage as CrmStage,
            changedBy: h.changed_by && h.handle ? { userId: h.changed_by, handle: h.handle } : null, at: h.created_at.toISOString(),
          })),
          notes: notes.map((n) => ({ id: n.id, body: n.body, author: n.author_id && n.handle ? { userId: n.author_id, handle: n.handle } : null, createdAt: n.created_at.toISOString() })),
        };
      },
    ),

    route(
      { method: 'post', path: `${prefix}/entries/:entryId/stage`, summary: 'Move a card to another stage (Contact Requested sends a contact request through the safety rules)', tag, auth: 'user', body: CrmStageChangeRequest, response: CrmEntryView, rateLimit: { max: 120, timeWindow: '1 minute' } },
      async (ctx) => {
        const s = await scopeFor(ctx, kind, 'crm.write');
        const me = ctx.me();
        const to = ctx.body.stage;
        const row = await ctx.deps.db.transaction().execute(async (tx) => {
          const e = await entryIn(tx, s, ctx.params.entryId, true);
          if (!(await visiblePlayers(ctx.deps, me, [e.player_id])).has(e.player_id)) throw notFound('pipeline card');
          const linked = e.contact_request_id
            ? await tx.selectFrom('contact_requests').select(['id', 'status']).where('id', '=', e.contact_request_id).executeTakeFirst()
            : undefined;
          const move = stageMove(e.stage as CrmStage, to, linked?.status === 'accepted');
          if (!move.ok) throw conflict(move.code, move.reason);
          let contactRequestId = e.contact_request_id;
          if (move.via === 'contact_request') {
            if (!ctx.body.message) throw new ApiError(400, 'MESSAGE_REQUIRED', 'write the message the player (or their guardian) will receive');
            if (linked?.status === 'pending') throw conflict('ALREADY_REQUESTED', 'a contact request for this card is still pending');
            // The existing contact flow decides: scout verification, discoverability, consent (the
            // guardian's for a minor), the player's contact toggle and routing to the guardian.
            const req = await sendContactRequest(ctx.deps, me, e.player_id, ctx.body.message, { organizationId: s.kind === 'org' ? s.orgId : null, tx });
            contactRequestId = req.id;
          }
          const updated = await tx.updateTable('crm_entries').set({ stage: to, contact_request_id: contactRequestId, updated_at: ctx.deps.now() })
            .where('id', '=', e.id).returningAll().executeTakeFirstOrThrow();
          await recordStage(tx, s, me.userId, e, e.stage, to, contactRequestId !== e.contact_request_id ? { contactRequestId } : {});
          return updated;
        });
        return entryView(ctx.deps, me, row);
      },
    ),

    route(
      { method: 'patch', path: `${prefix}/entries/:entryId`, summary: 'Set a card’s tags', tag, auth: 'user', body: UpdateCrmEntryRequest, response: CrmEntryView },
      async (ctx) => {
        const s = await scopeFor(ctx, kind, 'crm.write');
        const e = await entryIn(ctx.deps.db, s, ctx.params.entryId);
        const row = await ctx.deps.db.updateTable('crm_entries').set({ tags: normaliseTags(ctx.body.tags), updated_at: ctx.deps.now() })
          .where('id', '=', e.id).returningAll().executeTakeFirstOrThrow();
        return entryView(ctx.deps, ctx.me(), row);
      },
    ),

    route(
      { method: 'delete', path: `${prefix}/entries/:entryId`, summary: 'Remove a card, its history and notes from the pipeline', tag, auth: 'user', status: 204 },
      async (ctx) => {
        const s = await scopeFor(ctx, kind, 'crm.write');
        await ctx.deps.db.transaction().execute(async (tx) => {
          const e = await entryIn(tx, s, ctx.params.entryId, true);
          await tx.deleteFrom('crm_entries').where('id', '=', e.id).execute();
          await audit(tx, { actorId: ctx.me().userId, action: 'crm.entry_deleted', targetKind: 'crm_entry', targetId: e.id, metadata: { ...scopeLabel(s), playerId: e.player_id, stage: e.stage } });
        });
      },
    ),

    route(
      { method: 'post', path: `${prefix}/entries/:entryId/notes`, summary: 'Add a private note to a card', tag, auth: 'user', body: CreateCrmNoteRequest, response: CrmNoteView, status: 201 },
      async (ctx) => {
        const s = await scopeFor(ctx, kind, 'crm.note');
        const me = ctx.me();
        const e = await entryIn(ctx.deps.db, s, ctx.params.entryId);
        await entryView(ctx.deps, me, e);
        const n = await ctx.deps.db.insertInto('crm_notes').values({ id: newId(), entry_id: e.id, author_id: me.userId, body: ctx.body.body }).returningAll().executeTakeFirstOrThrow();
        const handle = (await ctx.deps.db.selectFrom('profiles').select('handle').where('user_id', '=', me.userId).executeTakeFirstOrThrow()).handle;
        return { id: n.id, body: n.body, author: { userId: me.userId, handle }, createdAt: n.created_at.toISOString() };
      },
    ),

    route(
      { method: 'delete', path: `${prefix}/notes/:noteId`, summary: 'Delete a note (its author, or an organization admin)', tag, auth: 'user', status: 204 },
      async (ctx) => {
        const s = await scopeFor(ctx, kind, 'crm.note');
        const id = Uuid.safeParse(ctx.params.noteId);
        const note = id.success
          ? await ctx.deps.db.selectFrom('crm_notes').innerJoin('crm_entries', 'crm_entries.id', 'crm_notes.entry_id')
            .select(['crm_notes.id', 'crm_notes.author_id']).where('crm_notes.id', '=', id.data)
            .where(s.kind === 'personal' ? 'crm_entries.owner_user_id' : 'crm_entries.organization_id', '=', s.kind === 'personal' ? s.ownerUserId : s.orgId)
            .executeTakeFirst()
          : undefined;
        if (!note) throw notFound('note');
        if (note.author_id !== ctx.me().userId && s.role !== 'owner' && s.role !== 'admin') throw forbidden('ORG_ROLE_REQUIRED', 'only the author or an admin can delete this note');
        await ctx.deps.db.deleteFrom('crm_notes').where('id', '=', note.id).execute();
      },
    ),

    // ---------------------------------------------------------------- saved searches
    route(
      { method: 'get', path: `${prefix}/saved-searches`, summary: `${kind === 'personal' ? 'My' : 'The organization’s'} saved searches`, tag, auth: 'user', response: SavedSearchList },
      async (ctx) => {
        const s = await scopeFor(ctx, kind, 'org.read');
        return { items: await savedSearchViews(ctx.deps, s) };
      },
    ),
    route(
      { method: 'post', path: `${prefix}/saved-searches`, summary: 'Save a scout search, optionally with alerts for new matching clips', tag, auth: 'user', body: CreateSavedSearchRequest, response: SavedSearchView, status: 201 },
      async (ctx) => {
        const s = await scopeFor(ctx, kind, 'crm.write');
        const count = await searchesIn(ctx.deps.db, s).select(ctx.deps.db.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
        if (Number(count.n) >= MAX_SAVED_SEARCHES) throw new ApiError(400, 'LIMIT_REACHED', `you can keep up to ${MAX_SAVED_SEARCHES} saved searches`);
        const id = newId();
        // Stored as the scout search schema parsed it, without empty values.
        const filters = Object.fromEntries(Object.entries(ctx.body.filters).filter(([, v]) => v !== undefined && v !== ''));
        await ctx.deps.db.insertInto('saved_searches').values({
          id, ...ownerColumns(s), created_by: ctx.me().userId, name: ctx.body.name, filters: JSON.stringify(filters),
          alerts_enabled: ctx.body.alerts, alerts_since: ctx.deps.now(),
        }).execute();
        return (await savedSearchViews(ctx.deps, s, id))[0]!;
      },
    ),
    route(
      { method: 'patch', path: `${prefix}/saved-searches/:searchId`, summary: 'Rename a saved search or switch its alerts', tag, auth: 'user', body: UpdateSavedSearchRequest, response: SavedSearchView },
      async (ctx) => {
        const s = await scopeFor(ctx, kind, 'crm.write');
        const row = await savedSearchIn(ctx.deps, s, ctx.params.searchId);
        const turningOn = ctx.body.alerts === true && !row.alerts_enabled;
        await ctx.deps.db.updateTable('saved_searches').set({
          ...(ctx.body.name !== undefined ? { name: ctx.body.name } : {}),
          ...(ctx.body.alerts !== undefined ? { alerts_enabled: ctx.body.alerts } : {}),
          // Switching alerts on never alerts for clips published while they were off.
          ...(turningOn ? { alerts_since: ctx.deps.now() } : {}),
          updated_at: ctx.deps.now(),
        }).where('id', '=', row.id).execute();
        return (await savedSearchViews(ctx.deps, s, row.id))[0]!;
      },
    ),
    route(
      { method: 'delete', path: `${prefix}/saved-searches/:searchId`, summary: 'Delete a saved search', tag, auth: 'user', status: 204 },
      async (ctx) => {
        const s = await scopeFor(ctx, kind, 'crm.write');
        const row = await savedSearchIn(ctx.deps, s, ctx.params.searchId);
        await ctx.deps.db.deleteFrom('saved_searches').where('id', '=', row.id).execute();
      },
    ),
  ];
}

export const crmRoutes = [...buildCrmRoutes('/v1/scout/crm', 'personal'), ...buildCrmRoutes('/v1/orgs/:orgId/crm', 'org')];
