import type { z } from 'zod';
import { CreateFeatureFlagRequest, EvaluatedFlags, FeatureFlagList, FeatureFlagView, FlagKey, UpdateFeatureFlagRequest } from '@fp/contracts';
import { route } from '../platform/route.js';
import { conflict, notFound } from '../platform/errors.js';
import { audit } from '../platform/events.js';
import { evaluateClientFlags, invalidateFlags, loadFlags } from '../platform/flags.js';
import type { StoredFlag } from '../platform/flags.js';
import type { Deps } from '../deps.js';

const view = (f: StoredFlag): z.input<typeof FeatureFlagView> => ({
  key: f.key, description: f.description, enabled: f.enabled, rolloutPercentage: f.rolloutPercentage,
  audience: { ...(f.audience.roles ? { roles: [...f.audience.roles] } : {}), ...(f.audience.countries ? { countries: [...f.audience.countries] } : {}) },
  clientVisible: f.clientVisible, updatedBy: f.updatedBy, updatedAt: f.updatedAt.toISOString(),
});

async function freshFlag(deps: Deps, key: string) {
  invalidateFlags(deps.db);
  const f = (await loadFlags(deps.db)).get(key);
  if (!f) throw notFound('flag');
  return f;
}

function flagKey(raw: string | undefined) {
  const k = FlagKey.safeParse(raw);
  if (!k.success) throw notFound('flag');
  return k.data;
}

export const flagRoutes = [
  route(
    { method: 'get', path: '/v1/flags', summary: 'Client-visible feature flags, evaluated for the caller', tag: 'flags', auth: 'optional', response: EvaluatedFlags },
    // Signed-out callers have no stable key (by design), so only fully rolled-out flags are on for them.
    async (ctx) => ({ flags: await evaluateClientFlags(ctx.deps, ctx.actor, null) }),
  ),

  route(
    { method: 'get', path: '/v1/admin/flags', summary: 'All feature flags (admin, MFA)', tag: 'admin', auth: 'user', response: FeatureFlagList },
    async (ctx) => {
      ctx.authorize({ kind: 'admin.access' });
      invalidateFlags(ctx.deps.db);
      return { items: [...(await loadFlags(ctx.deps.db)).values()].map(view) };
    },
  ),
  route(
    { method: 'post', path: '/v1/admin/flags', summary: 'Create a feature flag (admin, MFA; audited)', tag: 'admin', auth: 'user', body: CreateFeatureFlagRequest, response: FeatureFlagView, status: 201 },
    async (ctx) => {
      ctx.authorize({ kind: 'admin.access' });
      const me = ctx.me();
      const b = ctx.body;
      await ctx.deps.db.transaction().execute(async (tx) => {
        const row = await tx.insertInto('feature_flags').values({
          key: b.key, description: b.description, enabled: b.enabled, rollout_percentage: b.rolloutPercentage,
          audience: JSON.stringify(b.audience), client_visible: b.clientVisible, updated_by: me.userId,
        }).onConflict((oc) => oc.column('key').doNothing()).returning('key').executeTakeFirst();
        if (!row) throw conflict('FLAG_EXISTS', 'a flag with this key already exists');
        await audit(tx, { actorId: me.userId, action: 'flag.created', targetKind: 'feature_flag', metadata: { key: b.key, after: b } });
      });
      return view(await freshFlag(ctx.deps, b.key));
    },
  ),
  route(
    { method: 'patch', path: '/v1/admin/flags/:key', summary: 'Change a feature flag (admin, MFA; audited with before and after)', tag: 'admin', auth: 'user', body: UpdateFeatureFlagRequest, response: FeatureFlagView },
    async (ctx) => {
      ctx.authorize({ kind: 'admin.access' });
      const me = ctx.me();
      const key = flagKey(ctx.params.key);
      const b = ctx.body;
      await ctx.deps.db.transaction().execute(async (tx) => {
        const before = await tx.selectFrom('feature_flags').selectAll().where('key', '=', key).forUpdate().executeTakeFirst();
        if (!before) throw notFound('flag');
        await tx.updateTable('feature_flags').set({
          ...(b.description !== undefined && { description: b.description }),
          ...(b.enabled !== undefined && { enabled: b.enabled }),
          ...(b.rolloutPercentage !== undefined && { rollout_percentage: b.rolloutPercentage }),
          ...(b.audience !== undefined && { audience: JSON.stringify(b.audience) }),
          ...(b.clientVisible !== undefined && { client_visible: b.clientVisible }),
          updated_by: me.userId, updated_at: ctx.deps.now(),
        }).where('key', '=', key).execute();
        await audit(tx, {
          actorId: me.userId, action: 'flag.updated', targetKind: 'feature_flag',
          metadata: {
            key,
            before: { enabled: before.enabled, rolloutPercentage: before.rollout_percentage, audience: before.audience, clientVisible: before.client_visible },
            changes: b,
          },
        });
      });
      return view(await freshFlag(ctx.deps, key));
    },
  ),
  route(
    { method: 'delete', path: '/v1/admin/flags/:key', summary: 'Delete a feature flag; code checking it then sees it as off (admin, MFA; audited)', tag: 'admin', auth: 'user', status: 204 },
    async (ctx) => {
      ctx.authorize({ kind: 'admin.access' });
      const me = ctx.me();
      const key = flagKey(ctx.params.key);
      await ctx.deps.db.transaction().execute(async (tx) => {
        const gone = await tx.deleteFrom('feature_flags').where('key', '=', key).returningAll().executeTakeFirst();
        if (!gone) throw notFound('flag');
        await audit(tx, { actorId: me.userId, action: 'flag.deleted', targetKind: 'feature_flag', metadata: { key, before: { enabled: gone.enabled, rolloutPercentage: gone.rollout_percentage, audience: gone.audience } } });
      });
      invalidateFlags(ctx.deps.db);
    },
  ),
];
