import { sql } from 'kysely';
import { FeedPage, FeedQuery } from '@fp/contracts';
import { capability } from '@fp/domain';
import type { CapabilityKey } from '@fp/domain';
import { route } from '../platform/route.js';
import { ApiError } from '../platform/errors.js';
import { toVideoViews, videoSelect } from './media.js';

const TAB_CAPABILITY: Record<string, CapabilityKey> = {
  for_you: 'feed.for_you',
  new_talent: 'feed.new_talent',
  following: 'feed.following',
  trending: 'feed.trending',
  challenges: 'feed.challenges',
  nearby_talent: 'feed.nearby_talent',
  skills: 'feed.trending',
  match_clips: 'feed.trending',
};

/** New talent: players with a small audience and a recent account, so emerging players get seen. */
const NEW_TALENT_MAX_FOLLOWERS = 1000;
const NEW_TALENT_MAX_ACCOUNT_DAYS = 365;

const encodeCursor = (createdAt: Date, id: string) => Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(ts ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) throw new ApiError(400, 'INVALID_CURSOR', 'cursor is invalid');
  return { createdAt, id };
}

export const feedRoutes = [
  route(
    { method: 'get', path: '/v1/feed', summary: 'Video feed by tab', tag: 'feed', auth: 'optional', query: FeedQuery, response: FeedPage },
    async (ctx) => {
      const { tab, limit, cursor } = ctx.query;
      const cap = capability(TAB_CAPABILITY[tab]!);
      if (cap.status !== 'live') return { tab, capability: cap, items: [], nextCursor: null };
      if (tab === 'following' && !ctx.actor) throw new ApiError(401, 'UNAUTHENTICATED', 'sign in to see who you follow');

      const viewerId = ctx.actor?.userId ?? null;
      let q = ctx.deps.db
        .selectFrom('videos')
        .innerJoin('profiles', 'profiles.user_id', 'videos.owner_user_id')
        .innerJoin('privacy_settings', 'privacy_settings.user_id', 'videos.owner_user_id')
        .innerJoin('users', 'users.id', 'videos.owner_user_id')
        .select([...videoSelect])
        .where('videos.status', '=', 'ready')
        .where('videos.visibility', '=', 'public')
        .where('privacy_settings.profile_visibility', '=', 'public')
        .where('users.status', '=', 'active');

      if (viewerId) {
        q = q.where(({ not, exists, selectFrom, or, and, eb }) =>
          not(exists(selectFrom('blocks').select('blocker_id').where((b) =>
            or([
              and([b('blocks.blocker_id', '=', viewerId), b('blocks.blocked_id', '=', b.ref('videos.owner_user_id'))]),
              and([b('blocks.blocked_id', '=', viewerId), b('blocks.blocker_id', '=', b.ref('videos.owner_user_id'))]),
            ]),
          ))),
        );
      }
      if (tab === 'following') {
        q = q.where('videos.owner_user_id', 'in', (eb) => eb.selectFrom('follows').select('followee_id').where('follower_id', '=', viewerId!));
      }
      if (tab === 'new_talent') {
        q = q
          .where('videos.owner_user_id', 'in', (eb) => eb.selectFrom('user_roles').select('user_id').where('role', '=', 'player'))
          .where('users.created_at', '>', sql<Date>`now() - make_interval(days => ${NEW_TALENT_MAX_ACCOUNT_DAYS})`)
          .where((eb) => eb(eb.selectFrom('follows').select(eb.fn.countAll().as('n')).whereRef('followee_id', '=', 'videos.owner_user_id'), '<', NEW_TALENT_MAX_FOLLOWERS));
      }
      if (cursor) {
        const c = decodeCursor(cursor);
        q = q.where(sql<boolean>`(videos.created_at, videos.id) < (${c.createdAt}, ${c.id}::uuid)`);
      }

      const rows = await q.orderBy('videos.created_at', 'desc').orderBy('videos.id', 'desc').limit(limit + 1).execute();
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        tab,
        capability: cap,
        items: await toVideoViews(ctx.deps, ctx.actor, page),
        nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
      };
    },
  ),
];
