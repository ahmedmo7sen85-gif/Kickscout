import { z } from 'zod';
import { ProfileView, UpdateProfileRequest } from '@fp/contracts';
import { route } from '../platform/route.js';
import { ApiError, notFound } from '../platform/errors.js';
import { audit } from '../platform/events.js';
import { profileView } from './views.js';

export const profileRoutes = [
  route(
    { method: 'get', path: '/v1/profiles/:handle', summary: 'A profile, filtered to what the viewer may see', tag: 'profiles', auth: 'optional', response: ProfileView },
    async (ctx) => {
      const row = await ctx.deps.db.selectFrom('profiles').select('user_id').where('handle', '=', ctx.params.handle!).executeTakeFirst();
      // Hidden and missing profiles look the same, so existence is not leaked.
      const view = row ? await profileView(ctx.deps, ctx.actor, row.user_id) : null;
      if (!view) throw notFound('profile');
      return view;
    },
  ),

  route(
    { method: 'patch', path: '/v1/profiles/:userId', summary: 'Update a profile (self, guardian or admin)', tag: 'profiles', auth: 'user', body: UpdateProfileRequest, response: ProfileView },
    async (ctx) => {
      const subjectId = z.uuid().parse(ctx.params.userId);
      ctx.authorize({ kind: 'profile.update', subjectId });
      const { displayName, bio, regionCode, player } = ctx.body;

      await ctx.deps.db.transaction().execute(async (tx) => {
        let regionId: string | null | undefined;
        if (regionCode !== undefined) {
          if (regionCode === null) regionId = null;
          else {
            const r = await tx.selectFrom('regions').select('id').where('code', '=', regionCode).executeTakeFirst();
            if (!r) throw new ApiError(400, 'UNKNOWN_REGION', 'unknown region code');
            regionId = r.id;
          }
        }
        const profilePatch = {
          ...(displayName !== undefined && { display_name: displayName }),
          ...(bio !== undefined && { bio }),
          ...(regionId !== undefined && { region_id: regionId }),
        };
        if (Object.keys(profilePatch).length) {
          await tx.updateTable('profiles').set({ ...profilePatch, updated_at: ctx.deps.now() }).where('user_id', '=', subjectId).execute();
        }
        if (player) {
          const pp = await tx.selectFrom('player_profiles').select('user_id').where('user_id', '=', subjectId).executeTakeFirst();
          if (!pp) throw new ApiError(400, 'NOT_A_PLAYER', 'this account has no player profile');
          await tx.updateTable('player_profiles').set({
            ...(player.primaryPosition !== undefined && { primary_position: player.primaryPosition }),
            ...(player.secondaryPositions !== undefined && { secondary_positions: player.secondaryPositions }),
            ...(player.preferredFoot !== undefined && { preferred_foot: player.preferredFoot }),
          }).where('user_id', '=', subjectId).execute();
        }
        await audit(tx, { actorId: ctx.me().userId, action: 'profile.updated', targetKind: 'user', targetId: subjectId });
      });

      const view = await profileView(ctx.deps, ctx.actor, subjectId);
      if (!view) throw notFound('profile');
      return view;
    },
  ),
];
