import { z } from 'zod';
import { CommentPage, CommentView, CreateCommentRequest, CursorQuery, ReportRequest, VideoPage } from '@fp/contracts';
import { isMinor, SAVE_MILESTONES } from '@fp/domain';
import { route } from '../platform/route.js';
import { ApiError, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { audit, emit, notify } from '../platform/events.js';
import { openCase } from './moderation.js';
import { onVideoReported } from './guardian.js';
import { moderateComment } from '../platform/moderation.js';
import { ageBandOf } from '../platform/actor.js';
import { blockedEitherWay, pageOfVideos, videoQuery, visibleVideo } from './media.js';

const UserIdParam = z.uuid();

export const socialRoutes = [
  route(
    { method: 'put', path: '/v1/videos/:videoId/like', summary: 'Like a video', tag: 'social', auth: 'user', status: 204, rateLimit: { max: 120, timeWindow: '1 minute' } },
    async (ctx) => {
      ctx.authorize({ kind: 'social.engage' });
      const { row } = await visibleVideo(ctx.deps, ctx.actor, ctx.params.videoId!);
      const me = ctx.me();
      const liked = await ctx.deps.db.transaction().execute(async (tx) => {
        const res = await tx.insertInto('likes').values({ user_id: me.userId, video_id: row.id })
          .onConflict((oc) => oc.columns(['video_id', 'user_id']).doNothing()).returning('video_id').executeTakeFirst();
        if (res && row.owner_user_id !== me.userId) await notify(tx, row.owner_user_id, 'like', { videoId: row.id, userId: me.userId });
        return Boolean(res);
      });
      if (liked) await ctx.track('video_liked', { videoId: row.id });
    },
  ),
  route(
    { method: 'delete', path: '/v1/videos/:videoId/like', summary: 'Remove a like', tag: 'social', auth: 'user', status: 204 },
    async (ctx) => {
      await ctx.deps.db.deleteFrom('likes').where('user_id', '=', ctx.me().userId).where('video_id', '=', z.uuid().parse(ctx.params.videoId)).execute();
    },
  ),

  route(
    { method: 'put', path: '/v1/videos/:videoId/save', summary: 'Save a video', tag: 'social', auth: 'user', status: 204 },
    async (ctx) => {
      ctx.authorize({ kind: 'social.engage' });
      const { row } = await visibleVideo(ctx.deps, ctx.actor, ctx.params.videoId!);
      const me = ctx.me();
      const saved = await ctx.deps.db.transaction().execute(async (tx) => {
        const res = await tx.insertInto('saves').values({ user_id: me.userId, video_id: row.id })
          .onConflict((oc) => oc.columns(['user_id', 'video_id']).doNothing()).returning('video_id').executeTakeFirst();
        if (!res || row.owner_user_id === me.userId) return Boolean(res);
        const { n } = await tx.selectFrom('saves').select(tx.fn.countAll<string>().as('n')).where('video_id', '=', row.id).executeTakeFirstOrThrow();
        if ((SAVE_MILESTONES as readonly number[]).includes(Number(n))) await notify(tx, row.owner_user_id, 'save.milestone', { videoId: row.id, saves: Number(n) });
        return true;
      });
      if (saved) await ctx.track('video_saved', { videoId: row.id });
    },
  ),
  route(
    { method: 'delete', path: '/v1/videos/:videoId/save', summary: 'Remove a save', tag: 'social', auth: 'user', status: 204 },
    async (ctx) => {
      await ctx.deps.db.deleteFrom('saves').where('user_id', '=', ctx.me().userId).where('video_id', '=', z.uuid().parse(ctx.params.videoId)).execute();
    },
  ),
  route(
    { method: 'get', path: '/v1/me/saves', summary: 'Videos I saved', tag: 'social', auth: 'user', query: CursorQuery, response: VideoPage },
    async (ctx) => {
      const me = ctx.me();
      const q = videoQuery(ctx.deps.db)
        .where('videos.id', 'in', (eb) => eb.selectFrom('saves').select('video_id').where('user_id', '=', me.userId))
        .where('videos.status', '=', 'published');
      return pageOfVideos(ctx.deps, me, q, ctx.query);
    },
  ),

  route(
    { method: 'put', path: '/v1/users/:userId/follow', summary: 'Follow a user', tag: 'social', auth: 'user', status: 204 },
    async (ctx) => {
      ctx.authorize({ kind: 'social.engage' });
      const me = ctx.me();
      const target = UserIdParam.parse(ctx.params.userId);
      if (target === me.userId) throw new ApiError(400, 'SELF_FOLLOW', 'you cannot follow yourself');
      const exists = await ctx.deps.db.selectFrom('users').select('id').where('id', '=', target).where('status', '=', 'active').executeTakeFirst();
      if (!exists || (await blockedEitherWay(ctx.deps.db, me.userId, target))) throw notFound('user');
      const followed = await ctx.deps.db.transaction().execute(async (tx) => {
        const res = await tx.insertInto('follows').values({ follower_id: me.userId, followee_id: target })
          .onConflict((oc) => oc.columns(['follower_id', 'followee_id']).doNothing()).returning('followee_id').executeTakeFirst();
        if (res) await notify(tx, target, 'follow', { userId: me.userId });
        return Boolean(res);
      });
      if (followed) await ctx.track('follow', { followeeId: target });
    },
  ),
  route(
    { method: 'delete', path: '/v1/users/:userId/follow', summary: 'Unfollow a user', tag: 'social', auth: 'user', status: 204 },
    async (ctx) => {
      await ctx.deps.db.deleteFrom('follows').where('follower_id', '=', ctx.me().userId).where('followee_id', '=', UserIdParam.parse(ctx.params.userId)).execute();
    },
  ),

  route(
    { method: 'put', path: '/v1/users/:userId/block', summary: 'Block a user (also removes follows both ways)', tag: 'social', auth: 'user', status: 204 },
    async (ctx) => {
      const me = ctx.me();
      const target = UserIdParam.parse(ctx.params.userId);
      if (target === me.userId) throw new ApiError(400, 'SELF_BLOCK', 'you cannot block yourself');
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.insertInto('blocks').values({ blocker_id: me.userId, blocked_id: target }).onConflict((oc) => oc.columns(['blocker_id', 'blocked_id']).doNothing()).execute();
        await tx.deleteFrom('follows').where((eb) => eb.or([
          eb.and([eb('follower_id', '=', me.userId), eb('followee_id', '=', target)]),
          eb.and([eb('follower_id', '=', target), eb('followee_id', '=', me.userId)]),
        ])).execute();
      });
    },
  ),

  route(
    { method: 'get', path: '/v1/videos/:videoId/comments', summary: 'Visible comments on a video', tag: 'social', auth: 'optional', response: CommentPage },
    async (ctx) => {
      const { row } = await visibleVideo(ctx.deps, ctx.actor, ctx.params.videoId!);
      const items = await ctx.deps.db.selectFrom('comments').innerJoin('profiles', 'profiles.user_id', 'comments.author_id')
        .innerJoin('users', 'users.id', 'comments.author_id')
        .select(['comments.id', 'comments.body', 'comments.moderation', 'comments.created_at', 'comments.author_id', 'profiles.handle'])
        .where('comments.video_id', '=', row.id).where('comments.moderation', '=', 'visible').where('users.status', '!=', 'deleted')
        .orderBy('comments.created_at', 'desc').limit(50).execute();
      return {
        items: items.map((c) => ({ id: c.id, author: { userId: c.author_id, handle: c.handle }, body: c.body, status: c.moderation as never, createdAt: c.created_at.toISOString() })),
        nextCursor: null,
      };
    },
  ),
  route(
    { method: 'post', path: '/v1/videos/:videoId/comments', summary: 'Comment on a video', tag: 'social', auth: 'user', body: CreateCommentRequest, response: CommentView, status: 201, rateLimit: { max: 30, timeWindow: '10 minutes' } },
    async (ctx) => {
      const me = ctx.me();
      const { row, relation } = await visibleVideo(ctx.deps, me, ctx.params.videoId!);
      ctx.authorize({
        kind: 'comment.create',
        videoOwnerId: row.owner_user_id,
        commentsSetting: row.comments_setting as 'everyone' | 'followers' | 'off',
        isFollower: relation === 'guardian' || Boolean(await ctx.deps.db.selectFrom('follows').select('follower_id')
          .where('follower_id', '=', me.userId).where('followee_id', '=', row.owner_user_id).executeTakeFirst()),
        blocked: await blockedEitherWay(ctx.deps.db, me.userId, row.owner_user_id),
      });
      const ownerBand = await ageBandOf(ctx.deps.db, row.owner_user_id);
      const verdict = moderateComment(ctx.body.body, { onMinorsContent: ownerBand ? isMinor(ownerBand) : true });
      const id = newId();
      const handle = (await ctx.deps.db.selectFrom('profiles').select('handle').where('user_id', '=', me.userId).executeTakeFirstOrThrow()).handle;
      const created = await ctx.deps.db.transaction().execute(async (tx) => {
        const c = await tx.insertInto('comments').values({
          id, video_id: row.id, author_id: me.userId, parent_id: ctx.body.parentId ?? null, body: ctx.body.body, moderation: verdict.status,
        }).returning(['created_at']).executeTakeFirstOrThrow();
        if (verdict.status === 'held') {
          await openCase(tx, { targetKind: 'comment', targetId: id, source: 'rules', categories: verdict.reasons, priority: ownerBand && isMinor(ownerBand) ? 0 : 2 });
        } else if (row.owner_user_id !== me.userId) {
          await notify(tx, row.owner_user_id, 'comment', { videoId: row.id, commentId: id });
        }
        return c;
      });
      return { id, author: { userId: me.userId, handle }, body: ctx.body.body, status: verdict.status, createdAt: created.created_at.toISOString() };
    },
  ),

  route(
    { method: 'post', path: '/v1/reports', summary: 'Report a video, comment, user or organization', tag: 'safety', auth: 'user', body: ReportRequest, status: 202, rateLimit: { max: 30, timeWindow: '1 hour' } },
    async (ctx) => {
      ctx.authorize({ kind: 'report.create' });
      const { targetKind, targetId, reason, details } = ctx.body;
      // Child-safety reports, and any report about a minor's content, go to the front of the queue.
      let ownerId: string | undefined;
      if (targetKind === 'user') ownerId = targetId;
      // An organization has no single owner whose age matters here; it must exist and not be deleted.
      else if (targetKind === 'organization') ownerId = (await ctx.deps.db.selectFrom('organizations').select('id').where('id', '=', targetId).where('status', '!=', 'deleted').executeTakeFirst())?.id;
      else if (targetKind === 'video') ownerId = (await ctx.deps.db.selectFrom('videos').select('owner_user_id').where('id', '=', targetId).executeTakeFirst())?.owner_user_id;
      else ownerId = (await ctx.deps.db.selectFrom('comments').select('author_id').where('id', '=', targetId).executeTakeFirst())?.author_id;
      const band = ownerId && targetKind !== 'organization' ? await ageBandOf(ctx.deps.db, ownerId) : null;
      const priority = reason === 'child_safety' || (band && isMinor(band)) ? 0
        : reason === 'violence' || reason === 'hate' || reason === 'inappropriate_contact' || reason === 'fake_scout' ? 1 : 2;

      if (!ownerId) throw notFound(targetKind);
      await ctx.deps.db.transaction().execute(async (tx) => {
        const id = newId();
        await tx.insertInto('reports').values({ id, reporter_id: ctx.me().userId, target_kind: targetKind, target_id: targetId, reason, details: details ?? null, priority }).execute();
        // Reports about the same target share one open case, which climbs the queue as reports arrive.
        await openCase(tx, { targetKind, targetId, source: 'report', categories: [reason], priority, reports: 1 });
        // Guardian: a fresh scan, and serious or repeated reports take a public video down until a person decides.
        if (targetKind === 'video') await onVideoReported(tx, targetId, reason, ctx.deps.now());
        await audit(tx, { actorId: ctx.me().userId, action: 'report.created', targetKind, targetId, metadata: { reason, priority } });
        await emit(tx, 'report.created', { reportId: id, priority });
      });
    },
  ),
];
