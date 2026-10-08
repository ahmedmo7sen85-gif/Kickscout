import { z } from 'zod';
import { CreateUploadRequest, CreateUploadResponse, VideoView } from '@fp/contracts';
import { isMinor } from '@fp/domain';
import type { Actor } from '@fp/domain';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import { ApiError, conflict, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { audit, emit } from '../platform/events.js';
import { relationTo } from './views.js';

const EXTENSIONS: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };

export const videoSelect = [
  'videos.id', 'videos.owner_user_id', 'videos.status', 'videos.video_type', 'videos.caption', 'videos.hls_key',
  'videos.thumbnail_key', 'videos.duration_ms', 'videos.created_at', 'videos.visibility', 'profiles.handle', 'profiles.display_name',
] as const;

type VideoRow = {
  id: string; owner_user_id: string; status: string; video_type: string; caption: string | null; hls_key: string | null;
  thumbnail_key: string | null; duration_ms: number | null; created_at: Date; handle: string; display_name: string;
};

/** Adds like/comment counts and the viewer's like state to a page of videos, in two queries. */
export async function toVideoViews(deps: Deps, viewer: Actor | null, rows: VideoRow[]): Promise<z.input<typeof VideoView>[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [likeCounts, commentCounts, mine] = await Promise.all([
    deps.db.selectFrom('likes').select(['video_id', deps.db.fn.countAll<string>().as('n')]).where('video_id', 'in', ids).groupBy('video_id').execute(),
    deps.db.selectFrom('comments').select(['video_id', deps.db.fn.countAll<string>().as('n')]).where('video_id', 'in', ids).where('moderation', '=', 'visible').groupBy('video_id').execute(),
    viewer
      ? deps.db.selectFrom('likes').select('video_id').where('video_id', 'in', ids).where('user_id', '=', viewer.userId).execute()
      : Promise.resolve([]),
  ]);
  const likes = new Map(likeCounts.map((r) => [r.video_id, Number(r.n)]));
  const comments = new Map(commentCounts.map((r) => [r.video_id, Number(r.n)]));
  const liked = new Set(mine.map((r) => r.video_id));
  const cdn = deps.config.CDN_BASE_URL;
  return rows.map((r) => ({
    id: r.id,
    owner: { userId: r.owner_user_id, handle: r.handle, displayName: r.display_name },
    status: r.status as never,
    videoType: r.video_type as never,
    caption: r.caption,
    playbackUrl: r.status === 'ready' && r.hls_key ? `${cdn}/${r.hls_key}` : null,
    thumbnailUrl: r.thumbnail_key ? `${cdn}/${r.thumbnail_key}` : null,
    durationMs: r.duration_ms,
    likes: likes.get(r.id) ?? 0,
    comments: comments.get(r.id) ?? 0,
    likedByMe: liked.has(r.id),
    createdAt: r.created_at.toISOString(),
  }));
}

/** Loads a video the viewer may see, or throws 404 (hidden and missing look the same). */
export async function visibleVideo(deps: Deps, viewer: Actor | null, videoId: string) {
  const id = z.uuid().safeParse(videoId);
  if (!id.success) throw notFound('video');
  const row = await deps.db.selectFrom('videos').innerJoin('profiles', 'profiles.user_id', 'videos.owner_user_id')
    .innerJoin('privacy_settings', 'privacy_settings.user_id', 'videos.owner_user_id')
    .select([...videoSelect, 'privacy_settings.profile_visibility', 'privacy_settings.comments as comments_setting'])
    .where('videos.id', '=', id.data).where('videos.status', '!=', 'deleted').executeTakeFirst();
  if (!row) throw notFound('video');
  const relation = await relationTo(deps.db, viewer, row.owner_user_id);
  const privileged = relation === 'self' || relation === 'guardian' || relation === 'admin' || relation === 'moderator';
  if (!privileged) {
    if (row.status !== 'ready') throw notFound('video');
    if (row.visibility === 'private' || row.profile_visibility === 'private') throw notFound('video');
    if ((row.visibility === 'followers' || row.profile_visibility === 'followers') && relation !== 'follower') throw notFound('video');
  }
  return { row, relation };
}

export const mediaRoutes = [
  route(
    { method: 'post', path: '/v1/uploads', summary: 'Start an upload; returns a signed URL for the original', tag: 'media', auth: 'user', body: CreateUploadRequest, response: CreateUploadResponse, status: 201 },
    async (ctx) => {
      ctx.authorize({ kind: 'video.upload' });
      const me = ctx.me();
      const videoId = newId();
      const key = `originals/${me.userId}/${videoId}.${EXTENSIONS[ctx.body.contentType]}`;
      const upload = await ctx.deps.storage.presignPut(key, ctx.body.contentType, ctx.body.sizeBytes);
      await ctx.deps.db.insertInto('videos').values({
        id: videoId,
        owner_user_id: me.userId,
        original_key: key,
        content_type: ctx.body.contentType,
        size_bytes: ctx.body.sizeBytes,
        video_type: ctx.body.videoType,
        subject: ctx.body.subject,
        caption: ctx.body.caption ?? null,
        // A minor's uploads are never wider than followers until a guardian opens the profile.
        visibility: isMinor(me.ageBand) && !me.consents.has('public_profile') ? 'private' : ctx.body.visibility,
      }).execute();
      return { videoId, upload: { url: upload.url, method: 'PUT' as const, headers: upload.headers, expiresAt: upload.expiresAt.toISOString() } };
    },
  ),

  route(
    { method: 'post', path: '/v1/uploads/:videoId/complete', summary: 'Confirm the original finished uploading', tag: 'media', auth: 'user', response: VideoView },
    async (ctx) => {
      const me = ctx.me();
      const video = await ctx.deps.db.selectFrom('videos').selectAll().where('id', '=', z.uuid().parse(ctx.params.videoId)).executeTakeFirst();
      if (!video || video.owner_user_id !== me.userId) throw notFound('video');
      if (video.status !== 'awaiting_upload') throw conflict('ALREADY_COMPLETED', 'upload already completed');
      const head = await ctx.deps.storage.head(video.original_key);
      if (!head) throw new ApiError(409, 'UPLOAD_MISSING', 'the file has not arrived yet');
      if (head.sizeBytes !== Number(video.size_bytes) || head.contentType !== video.content_type) {
        throw new ApiError(422, 'UPLOAD_MISMATCH', 'uploaded file does not match what was declared');
      }
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.updateTable('videos').set({ status: 'uploaded' }).where('id', '=', video.id).execute();
        // The media service scans, probes and transcodes, then calls back with the renditions.
        await emit(tx, 'video.uploaded', { videoId: video.id, key: video.original_key });
      });
      const { row } = await visibleVideo(ctx.deps, me, video.id);
      return (await toVideoViews(ctx.deps, me, [row]))[0]!;
    },
  ),

  route(
    { method: 'get', path: '/v1/videos/:videoId', summary: 'A video', tag: 'media', auth: 'optional', response: VideoView },
    async (ctx) => {
      const { row } = await visibleVideo(ctx.deps, ctx.actor, ctx.params.videoId!);
      return (await toVideoViews(ctx.deps, ctx.actor, [row]))[0]!;
    },
  ),

  route(
    { method: 'delete', path: '/v1/videos/:videoId', summary: 'Delete a video (owner, guardian or staff)', tag: 'media', auth: 'user', status: 204 },
    async (ctx) => {
      const video = await ctx.deps.db.selectFrom('videos').select(['id', 'owner_user_id', 'original_key']).where('id', '=', z.uuid().parse(ctx.params.videoId)).where('status', '!=', 'deleted').executeTakeFirst();
      if (!video) throw notFound('video');
      ctx.authorize({ kind: 'video.delete', ownerId: video.owner_user_id });
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.updateTable('videos').set({ status: 'deleted', deleted_at: ctx.deps.now() }).where('id', '=', video.id).execute();
        // Object purge runs from this event, honouring legal holds.
        await emit(tx, 'video.deleted', { videoId: video.id, key: video.original_key });
        await audit(tx, { actorId: ctx.me().userId, action: 'video.deleted', targetKind: 'video', targetId: video.id });
      });
    },
  ),

  route(
    {
      method: 'post', path: '/internal/media/:videoId/processed', summary: 'Media service reports a transcoded video', tag: 'internal', auth: 'service', status: 204,
      body: z.object({
        status: z.enum(['ready', 'rejected']),
        rejectReason: z.string().max(200).optional(),
        hlsKey: z.string().max(500).optional(),
        thumbnailKey: z.string().max(500).optional(),
        durationMs: z.number().int().positive().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().positive().optional(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      }),
    },
    async (ctx) => {
      const videoId = z.uuid().parse(ctx.params.videoId);
      const b = ctx.body;
      await ctx.deps.db.transaction().execute(async (tx) => {
        const res = await tx.updateTable('videos').set({
          status: b.status,
          hls_key: b.hlsKey ?? null,
          thumbnail_key: b.thumbnailKey ?? null,
          duration_ms: b.durationMs ?? null,
          width: b.width ?? null,
          height: b.height ?? null,
          fps: b.fps ?? null,
          ready_at: b.status === 'ready' ? ctx.deps.now() : null,
        }).where('id', '=', videoId).where('status', 'in', ['uploaded', 'processing']).executeTakeFirst();
        if (res.numUpdatedRows === 0n) throw conflict('INVALID_STATE', 'video is not awaiting processing');
        if (b.sha256) {
          await tx.insertInto('video_hashes').values({ video_id: videoId, sha256: Buffer.from(b.sha256, 'hex') })
            .onConflict((oc) => oc.column('video_id').doNothing()).execute();
        }
        await emit(tx, `video.${b.status}`, { videoId, reason: b.rejectReason ?? null });
      });
    },
  ),
];
