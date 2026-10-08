import { sql } from 'kysely';
import { FeedPage, FeedQuery } from '@fp/contracts';
import { capability } from '@fp/domain';
import type { CapabilityKey } from '@fp/domain';
import { route } from '../platform/route.js';
import { ApiError } from '../platform/errors.js';
import { discoverable, pageOfVideos, toVideoViews, videoQuery } from './media.js';

const TAB_CAPABILITY: Record<string, CapabilityKey> = {
  for_you: 'feed.for_you',
  new_talent: 'feed.new_talent',
  following: 'feed.following',
  trending: 'feed.trending',
};

/** New talent: players with a small audience and a recent account, so emerging players get seen. */
const NEW_TALENT_MAX_FOLLOWERS = 1000;
const NEW_TALENT_MAX_ACCOUNT_DAYS = 365;
const TRENDING_WINDOW_DAYS = 7;

export const feedRoutes = [
  route(
    { method: 'get', path: '/v1/feed', summary: 'Video feed by tab', tag: 'feed', auth: 'optional', query: FeedQuery, response: FeedPage },
    async (ctx) => {
      const { tab, limit, cursor } = ctx.query;
      const cap = capability(TAB_CAPABILITY[tab]!);
      if (cap.status !== 'live') return { tab, capability: cap, items: [], nextCursor: null };
      if (tab === 'following' && !ctx.actor) throw new ApiError(401, 'UNAUTHENTICATED', 'sign in to see who you follow');
      const viewer = ctx.actor;
      let q = discoverable(videoQuery(ctx.deps.db), viewer);

      if (tab === 'following') {
        q = q.where('videos.owner_user_id', 'in', (eb) => eb.selectFrom('follows').select('followee_id').where('follower_id', '=', viewer!.userId));
      }
      if (tab === 'new_talent') {
        q = q
          .where('videos.owner_user_id', 'in', (eb) => eb.selectFrom('user_roles').select('user_id').where('role', '=', 'player'))
          .where('users.created_at', '>', sql<Date>`now() - make_interval(days => ${NEW_TALENT_MAX_ACCOUNT_DAYS})`)
          .where((eb) => eb(eb.selectFrom('follows').select(eb.fn.countAll().as('n')).whereRef('followee_id', '=', 'videos.owner_user_id'), '<', NEW_TALENT_MAX_FOLLOWERS));
      }
      if (tab === 'trending') {
        // Engagement in the last week (likes count double views, saves triple). Offset paging: the order shifts as counts change.
        const offset = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10) : 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > 1000) throw new ApiError(400, 'INVALID_CURSOR', 'cursor is invalid');
        const since = sql<Date>`now() - make_interval(days => ${TRENDING_WINDOW_DAYS})`;
        const score = sql<number>`(
          2 * (SELECT count(*) FROM likes l WHERE l.video_id = videos.id AND l.created_at > ${since})
          + 3 * (SELECT count(*) FROM saves s WHERE s.video_id = videos.id AND s.created_at > ${since})
          + (SELECT count(*) FROM video_views v WHERE v.video_id = videos.id AND v.day > (${since})::date))`;
        const rows = await q.where(score, '>', 0).orderBy(score, 'desc').orderBy('videos.id', 'desc').offset(offset).limit(limit + 1).execute();
        const items = rows.slice(0, limit);
        return {
          tab, capability: cap, items: await toVideoViews(ctx.deps, viewer, items),
          nextCursor: rows.length > limit ? Buffer.from(String(offset + limit)).toString('base64url') : null,
        };
      }
      return { tab, capability: cap, ...(await pageOfVideos(ctx.deps, viewer, q, { limit, cursor })) };
    },
  ),
];

