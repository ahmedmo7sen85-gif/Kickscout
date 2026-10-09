import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'kysely';
import { CreateUploadRequest, CreateUploadResponse, TagCorrectionRequest, UpdateVideoRequest, VideoPage, VideoView, CursorQuery } from '@fp/contracts';
import { isMinor } from '@fp/domain';
import type { Actor, Limits } from '@fp/domain';
import type { Database, DB } from '@fp/db';
import type { Transaction } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import { ApiError, conflict, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { mediaUrl } from '../platform/storage.js';
import { audit, emit, enqueue } from '../platform/events.js';
import { canSeeInternals, relationTo } from './views.js';
import { decodeCursor, encodeCursor } from '../platform/cursor.js';
import { entitlementsFor, uploadUsage } from '../platform/entitlements.js';

const EXTENSIONS: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };

/** Base query for videos with everything a VideoView needs. Callers add the visibility filters. */
export function videoQuery(db: Database) {
  return db
    .selectFrom('videos')
    .innerJoin('users', 'users.id', 'videos.owner_user_id')
    .innerJoin('profiles', 'profiles.user_id', 'videos.owner_user_id')
    .innerJoin('privacy_settings', 'privacy_settings.user_id', 'videos.owner_user_id')
    .leftJoin('regions', 'regions.id', 'profiles.region_id')
    .select([
      'videos.id', 'videos.owner_user_id', 'videos.status', 'videos.status_reason', 'videos.moderation', 'videos.title',
      'videos.description', 'videos.skill_key', 'videos.position', 'videos.foot', 'videos.context', 'videos.visibility',
      'videos.playback_key', 'videos.thumbnail_key', 'videos.duration_ms', 'videos.created_at', 'videos.published_at',
      'profiles.handle', 'profiles.display_name', 'profiles.avatar_key', 'profiles.verified_at', 'users.is_demo',
      'regions.country_code', 'privacy_settings.region_precision', 'privacy_settings.profile_visibility',
      'privacy_settings.comments as comments_setting', 'privacy_settings.show_country', 'users.status as owner_status',
    ]);
}
type VideoQuery = ReturnType<typeof videoQuery>;
export type VideoRow = Awaited<ReturnType<VideoQuery['executeTakeFirstOrThrow']>>;

/**
 * Restricts a video query to what anyone may discover: published, public, from an active public
 * profile, and not between users who blocked each other. Unlisted profiles are left out of every
 * list except their own profile page (`includeUnlisted`), which is reached by direct link.
 */
export function discoverable(q: VideoQuery, viewer: Actor | null, opts: { includeUnlisted?: boolean } = {}): VideoQuery {
  let out = q
    .where('videos.status', '=', 'published')
    .where('videos.visibility', '=', 'public')
    .where('privacy_settings.profile_visibility', 'in', opts.includeUnlisted ? ['public', 'unlisted'] : ['public'])
    .where('users.status', '=', 'active');
  if (viewer) {
    const me = viewer.userId;
    out = out.where(({ not, exists, selectFrom, or, and }) =>
      not(exists(selectFrom('blocks').select('blocker_id').where((b) =>
        or([
          and([b('blocks.blocker_id', '=', me), b('blocks.blocked_id', '=', b.ref('videos.owner_user_id'))]),
          and([b('blocks.blocked_id', '=', me), b('blocks.blocker_id', '=', b.ref('videos.owner_user_id'))]),
        ]),
      ))),
    );
  }
  return out;
}

/** Keyset pagination on (published_at, id) for public lists. */
export async function pageOfVideos(deps: Deps, viewer: Actor | null, q: VideoQuery, page: z.output<typeof CursorQuery>) {
  if (page.cursor) {
    const c = decodeCursor(page.cursor);
    q = q.where(sql<boolean>`(coalesce(videos.published_at, videos.created_at), videos.id) < (${c.at}, ${c.id}::uuid)`);
  }
  const rows = await q.orderBy(sql`coalesce(videos.published_at, videos.created_at)`, 'desc').orderBy('videos.id', 'desc').limit(page.limit + 1).execute();
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items: await toVideoViews(deps, viewer, items),
    nextCursor: rows.length > page.limit && last ? encodeCursor(last.published_at ?? last.created_at, last.id) : null,
  };
}

/** Counts, tags, hashtags and the viewer's own state for a page of videos, in a fixed number of queries. */
export async function toVideoViews(deps: Deps, viewer: Actor | null, rows: VideoRow[]): Promise<z.input<typeof VideoView>[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const db = deps.db;
  const count = (table: 'likes' | 'saves') =>
    db.selectFrom(table).select(['video_id', db.fn.countAll<string>().as('n')]).where('video_id', 'in', ids).groupBy('video_id').execute();
  const [likeCounts, saveCounts, commentCounts, myLikes, mySaves, tags, hashtags] = await Promise.all([
    count('likes'),
    count('saves'),
    db.selectFrom('comments').innerJoin('users', 'users.id', 'comments.author_id').select(['comments.video_id', db.fn.countAll<string>().as('n')])
      .where('comments.video_id', 'in', ids).where('comments.moderation', '=', 'visible').where('users.status', '!=', 'deleted').groupBy('comments.video_id').execute(),
    viewer ? db.selectFrom('likes').select('video_id').where('video_id', 'in', ids).where('user_id', '=', viewer.userId).execute() : Promise.resolve([]),
    viewer ? db.selectFrom('saves').select('video_id').where('video_id', 'in', ids).where('user_id', '=', viewer.userId).execute() : Promise.resolve([]),
    db.selectFrom('video_skills').innerJoin('skills', 'skills.key', 'video_skills.skill_key')
      .select(['video_skills.video_id', 'video_skills.skill_key', 'video_skills.source', 'video_skills.confidence', 'video_skills.model', 'skills.names', 'skills.sort_order'])
      .where('video_skills.video_id', 'in', ids).where('video_skills.status', '=', 'active').execute(),
    db.selectFrom('video_hashtags').select(['video_id', 'tag']).where('video_id', 'in', ids).orderBy('tag').execute(),
  ]);
  const toMap = (rs: { video_id: string; n: string }[]) => new Map(rs.map((r) => [r.video_id, Number(r.n)]));
  const likes = toMap(likeCounts);
  const saves = toMap(saveCounts);
  const comments = toMap(commentCounts);
  const liked = new Set(myLikes.map((r) => r.video_id));
  const saved = new Set(mySaves.map((r) => r.video_id));
  const cdn = deps.config.CDN_BASE_URL;

  return rows.map((r) => {
    // One tag per skill: the player's own tag wins over the AI suggestion for the same skill.
    const bySkill = new Map<string, (typeof tags)[number]>();
    for (const t of tags.filter((t) => t.video_id === r.id)) {
      const prev = bySkill.get(t.skill_key);
      if (!prev || (prev.source === 'ai' && t.source === 'user')) bySkill.set(t.skill_key, t);
    }
    const internals = canSeeInternals(viewer, r.owner_user_id);
    return {
      id: r.id,
      owner: {
        userId: r.owner_user_id, handle: r.handle, displayName: r.display_name,
        avatarUrl: r.avatar_key ? mediaUrl(cdn, r.avatar_key) : null, verified: r.verified_at !== null, isDemo: r.is_demo,
      },
      status: r.status as never,
      statusReason: internals ? r.status_reason : null,
      moderation: internals ? (r.moderation as never) : null,
      title: r.title,
      description: r.description,
      skill: r.skill_key as never,
      position: r.position as never,
      foot: r.foot as never,
      context: r.context as never,
      country: r.region_precision === 'macro' || !r.show_country ? null : r.country_code,
      visibility: r.visibility as never,
      tags: [...bySkill.values()]
        .sort((a, b) => (a.source === b.source ? a.sort_order - b.sort_order : a.source === 'user' ? -1 : 1))
        .map((t) => ({ skill: t.skill_key as never, name: t.names as { en: string; ar: string }, source: t.source as 'ai' | 'user', confidence: t.source === 'ai' && t.confidence !== null ? Number(t.confidence) : null,
          // Which model suggested an AI tag: for the owner and staff (moderation views), not the public.
          model: t.source === 'ai' && internals ? t.model : null })),
      hashtags: hashtags.filter((h) => h.video_id === r.id).map((h) => h.tag),
      playbackUrl: r.status === 'published' || (internals && r.playback_key) ? (r.playback_key ? mediaUrl(cdn, r.playback_key) : null) : null,
      thumbnailUrl: r.thumbnail_key ? mediaUrl(cdn, r.thumbnail_key) : null,
      durationMs: r.duration_ms,
      likes: likes.get(r.id) ?? 0,
      comments: comments.get(r.id) ?? 0,
      saves: saves.get(r.id) ?? 0,
      likedByMe: liked.has(r.id),
      savedByMe: saved.has(r.id),
      createdAt: r.created_at.toISOString(),
      publishedAt: r.published_at?.toISOString() ?? null,
    };
  });
}

/** Loads a video the viewer may see, or throws 404 (hidden and missing look the same). */
export async function visibleVideo(deps: Deps, viewer: Actor | null, videoId: string) {
  const id = z.uuid().safeParse(videoId);
  if (!id.success) throw notFound('video');
  const row = await videoQuery(deps.db).where('videos.id', '=', id.data).where('videos.status', '!=', 'deleted').executeTakeFirst();
  if (!row) throw notFound('video');
  const relation = await relationTo(deps.db, viewer, row.owner_user_id);
  const privileged = relation === 'self' || relation === 'guardian' || relation === 'admin' || relation === 'moderator';
  if (!privileged) {
    // Suspended and deleted accounts take their videos with them.
    if (row.status !== 'published' || row.owner_status !== 'active') throw notFound('video');
    if (row.visibility === 'private' || row.profile_visibility === 'private') throw notFound('video');
    if ((row.visibility === 'followers' || row.profile_visibility === 'followers') && relation !== 'follower') throw notFound('video');
    if (viewer && (await blockedEitherWay(deps.db, viewer.userId, row.owner_user_id))) throw notFound('video');
  }
  return { row, relation };
}

export async function blockedEitherWay(db: Database, a: string, b: string) {
  const row = await db.selectFrom('blocks').select('blocker_id')
    .where((eb) => eb.or([
      eb.and([eb('blocker_id', '=', a), eb('blocked_id', '=', b)]),
      eb.and([eb('blocker_id', '=', b), eb('blocked_id', '=', a)]),
    ])).executeTakeFirst();
  return Boolean(row);
}

/** A minor's uploads stay private until a guardian has opened the profile to the public. */
export function effectiveVisibility(me: Actor, requested: 'public' | 'followers' | 'private') {
  return isMinor(me.ageBand) && !me.consents.has('public_profile') ? 'private' : requested;
}

async function ownedVideo(deps: Deps, me: Actor, videoId: string | undefined) {
  const id = z.uuid().safeParse(videoId);
  if (!id.success) throw notFound('video');
  const video = await deps.db.selectFrom('videos').selectAll().where('id', '=', id.data).where('status', '!=', 'deleted').executeTakeFirst();
  // Someone else's video looks missing rather than forbidden.
  if (!video || !(video.owner_user_id === me.userId || me.guardianOf.includes(video.owner_user_id) || me.roles.includes('admin'))) throw notFound('video');
  return video;
}

export async function replaceHashtags(tx: Transaction<DB>, videoId: string, tags: readonly string[]) {
  await tx.deleteFrom('video_hashtags').where('video_id', '=', videoId).execute();
  const unique = [...new Set(tags)];
  if (unique.length) await tx.insertInto('video_hashtags').values(unique.map((tag) => ({ video_id: videoId, tag }))).execute();
}

async function viewOf(deps: Deps, viewer: Actor, videoId: string) {
  const row = await videoQuery(deps.db).where('videos.id', '=', videoId).executeTakeFirstOrThrow();
  return (await toVideoViews(deps, viewer, [row]))[0]!;
}

/**
 * Caps how many live videos a player keeps and how many uploads they start per day, to bound storage
 * and processing cost. The numbers come from the player's plan (see platform/entitlements.ts); the
 * configured MAX_* values are the free-plan defaults.
 */
export async function checkUploadQuota(deps: Deps, userId: string, limits: Pick<Limits, 'maxActiveVideos' | 'maxUploadsPerDay'>): Promise<void> {
  const { maxActiveVideos, maxUploadsPerDay } = limits;
  const row = await uploadUsage(deps, userId);
  if (row.active >= maxActiveVideos) {
    throw new ApiError(403, 'QUOTA_ACTIVE_VIDEOS', `you already have ${maxActiveVideos} videos; delete one to upload another`);
  }
  if (row.today >= maxUploadsPerDay) {
    throw new ApiError(429, 'QUOTA_DAILY_UPLOADS', `you can start ${maxUploadsPerDay} uploads per day; try again tomorrow`);
  }
}

/**
 * Nudges the serverless worker so processing starts right away instead of at the next scheduled run.
 * Best effort: the job is already queued, so failures are only logged. The request is cut short on purpose;
 * the worker keeps running after the caller disconnects.
 */
export async function wakeWorker(deps: Deps, log: FastifyBaseLogger): Promise<void> {
  const { WORKER_TRIGGER_URL: url, WORKER_TRIGGER_SECRET: secret } = deps.config;
  if (!url || !secret) return;
  try {
    await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(1500) });
  } catch (err) {
    if ((err as Error).name !== 'TimeoutError') log.warn({ err }, 'worker trigger failed');
  }
}

export interface UploadFields {
  contentType: keyof typeof EXTENSIONS | string;
  sizeBytes: number;
  title: string;
  description?: string | undefined;
  skillKey?: string | undefined;
  position?: string | undefined;
  foot?: string | undefined;
  context?: string | undefined;
  hashtags: readonly string[];
  visibility: 'public' | 'followers' | 'private';
  trimStartMs?: number | undefined;
  trimEndMs?: number | undefined;
}

export interface UploadPlan {
  /** Video category to record (a challenge entry is always `challenge`). */
  context?: string;
  /** A tighter length limit than the plan's, e.g. the challenge's maximum. */
  maxDurationMs?: number;
  /** Runs inside the transaction that creates the video row (a challenge entry writes its submission here). */
  inTx?: (tx: Transaction<DB>, videoId: string) => Promise<void>;
}

/**
 * Checks the plan quota, signs the upload URL and records the video as `uploading`. The worker takes
 * over once the client confirms the upload; nothing is public until the safety pipeline publishes it.
 */
export async function beginUpload(deps: Deps, me: Actor, b: UploadFields, plan: UploadPlan = {}) {
  const { limits } = await entitlementsFor(deps, me.userId, me.roles);
  await checkUploadQuota(deps, me.userId, limits);
  const videoId = newId();
  const key = `originals/${me.userId}/${videoId}.${EXTENSIONS[b.contentType]}`;
  const upload = await deps.storage.presignPut(key, b.contentType, b.sizeBytes);
  await deps.db.transaction().execute(async (tx) => {
    const region = await tx.selectFrom('profiles').select('region_id').where('user_id', '=', me.userId).executeTakeFirst();
    await tx.insertInto('videos').values({
      id: videoId,
      owner_user_id: me.userId,
      original_key: key,
      declared_type: b.contentType,
      size_bytes: b.sizeBytes,
      title: b.title,
      description: b.description ?? null,
      skill_key: b.skillKey ?? null,
      position: b.position ?? null,
      foot: b.foot ?? null,
      context: plan.context ?? b.context ?? null,
      visibility: effectiveVisibility(me, b.visibility),
      region_id: region?.region_id ?? null,
      trim_start_ms: b.trimStartMs ?? null,
      trim_end_ms: b.trimEndMs ?? null,
      // The worker enforces the clip length the uploader's plan allowed when the upload started.
      max_duration_ms: Math.min(limits.maxVideoSeconds * 1000, plan.maxDurationMs ?? Infinity),
      rights_confirmed_at: deps.now(),
    }).execute();
    await replaceHashtags(tx, videoId, b.hashtags);
    if (b.skillKey) await tx.insertInto('video_skills').values({ video_id: videoId, skill_key: b.skillKey, source: 'user' }).execute();
    await plan.inTx?.(tx, videoId);
  });
  return { videoId, key, upload: { url: upload.url, method: 'PUT' as const, headers: upload.headers, expiresAt: upload.expiresAt.toISOString() } };
}

export const mediaRoutes = [
  route(
    { method: 'post', path: '/v1/uploads', summary: 'Start an upload; returns a signed URL for the original', tag: 'videos', auth: 'user', body: CreateUploadRequest, response: CreateUploadResponse, status: 201, rateLimit: { max: 20, timeWindow: '1 hour' } },
    async (ctx) => {
      ctx.authorize({ kind: 'video.upload' });
      const b = ctx.body;
      if (b.challengeId) {
        // An upload straight into a challenge is a challenge entry, with the same checks as POST /v1/challenges/:slug/submissions.
        const { submitToChallenge } = await import('./challenge-entry.js');
        const r = await submitToChallenge(ctx, b.challengeId, { ...b, othersInClip: false, consentOthers: false, safetyAck: false });
        if (!r.upload) throw conflict('ALREADY_COMPLETED', 'upload already completed');
        return { videoId: r.videoId, upload: r.upload };
      }
      const { videoId, upload } = await beginUpload(ctx.deps, ctx.me(), b);
      await ctx.track('upload_started', { videoId, challenge: false });
      return { videoId, upload };
    },
  ),

  route(
    { method: 'post', path: '/v1/uploads/:videoId/complete', summary: 'Confirm the original finished uploading; processing starts in the background', tag: 'videos', auth: 'user', response: VideoView },
    async (ctx) => {
      const me = ctx.me();
      const video = await ownedVideo(ctx.deps, me, ctx.params.videoId);
      if (video.status !== 'uploading') throw conflict('ALREADY_COMPLETED', 'upload already completed');
      const head = await ctx.deps.storage.head(video.original_key);
      if (!head) throw new ApiError(409, 'UPLOAD_MISSING', 'the file has not arrived yet');
      // Size is checked here; the real format, length and integrity are checked by the worker on the file itself.
      if (head.sizeBytes !== Number(video.size_bytes)) throw new ApiError(422, 'UPLOAD_MISMATCH', 'uploaded file does not match what was declared');
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.updateTable('videos').set({ status: 'processing' }).where('id', '=', video.id).execute();
        await enqueue(tx, 'video.process', { videoId: video.id });
      });
      await wakeWorker(ctx.deps, ctx.req.log);
      return viewOf(ctx.deps, me, video.id);
    },
  ),

  route(
    { method: 'get', path: '/v1/videos/:videoId', summary: 'A video', tag: 'videos', auth: 'optional', response: VideoView },
    async (ctx) => {
      const { row } = await visibleVideo(ctx.deps, ctx.actor, ctx.params.videoId!);
      return (await toVideoViews(ctx.deps, ctx.actor, [row]))[0]!;
    },
  ),

  route(
    { method: 'patch', path: '/v1/videos/:videoId', summary: 'Edit a video’s details (owner or guardian)', tag: 'videos', auth: 'user', body: UpdateVideoRequest, response: VideoView },
    async (ctx) => {
      const me = ctx.me();
      const video = await ownedVideo(ctx.deps, me, ctx.params.videoId);
      ctx.authorize({ kind: 'video.edit', ownerId: video.owner_user_id });
      const b = ctx.body;
      await ctx.deps.db.transaction().execute(async (tx) => {
        const patch = {
          ...(b.title !== undefined && { title: b.title }),
          ...(b.description !== undefined && { description: b.description }),
          ...(b.skillKey !== undefined && { skill_key: b.skillKey }),
          ...(b.position !== undefined && { position: b.position }),
          ...(b.foot !== undefined && { foot: b.foot }),
          ...(b.context !== undefined && { context: b.context }),
          ...(b.visibility !== undefined && { visibility: effectiveVisibility(me, b.visibility) }),
        };
        if (Object.keys(patch).length) await tx.updateTable('videos').set(patch).where('id', '=', video.id).execute();
        if (b.skillKey) {
          await tx.insertInto('video_skills').values({ video_id: video.id, skill_key: b.skillKey, source: 'user' })
            .onConflict((oc) => oc.columns(['video_id', 'skill_key', 'source']).doUpdateSet({ status: 'active' })).execute();
        }
        if (b.hashtags) await replaceHashtags(tx, video.id, b.hashtags);
      });
      return viewOf(ctx.deps, me, video.id);
    },
  ),

  route(
    { method: 'post', path: '/v1/videos/:videoId/tags', summary: 'Correct skill tags: add your own, reject AI suggestions', tag: 'videos', auth: 'user', body: TagCorrectionRequest, response: VideoView },
    async (ctx) => {
      const me = ctx.me();
      const video = await ownedVideo(ctx.deps, me, ctx.params.videoId);
      ctx.authorize({ kind: 'video.edit', ownerId: video.owner_user_id });
      const { add, reject } = ctx.body;
      await ctx.deps.db.transaction().execute(async (tx) => {
        for (const skill of add) {
          await tx.insertInto('video_skills').values({ video_id: video.id, skill_key: skill, source: 'user' })
            .onConflict((oc) => oc.columns(['video_id', 'skill_key', 'source']).doUpdateSet({ status: 'active' })).execute();
        }
        if (reject.length) {
          // Rejected tags stay in the table for audit and model evaluation; they are never shown again.
          await tx.updateTable('video_skills').set({ status: 'rejected' }).where('video_id', '=', video.id).where('skill_key', 'in', reject).execute();
        }
        await audit(tx, { actorId: me.userId, action: 'video.tags_corrected', targetKind: 'video', targetId: video.id, metadata: { add, reject } });
      });
      return viewOf(ctx.deps, me, video.id);
    },
  ),

  route(
    { method: 'delete', path: '/v1/videos/:videoId', summary: 'Delete a video (owner, guardian or staff)', tag: 'videos', auth: 'user', status: 204 },
    async (ctx) => {
      const video = await ctx.deps.db.selectFrom('videos').select(['id', 'owner_user_id', 'original_key']).where('id', '=', z.uuid().parse(ctx.params.videoId)).where('status', '!=', 'deleted').executeTakeFirst();
      if (!video) throw notFound('video');
      ctx.authorize({ kind: 'video.delete', ownerId: video.owner_user_id });
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.updateTable('videos').set({ status: 'deleted', deleted_at: ctx.deps.now() }).where('id', '=', video.id).execute();
        // Object purge runs from this event.
        await emit(tx, 'video.deleted', { videoId: video.id, key: video.original_key });
        await audit(tx, { actorId: ctx.me().userId, action: 'video.deleted', targetKind: 'video', targetId: video.id });
      });
    },
  ),

  route(
    { method: 'post', path: '/v1/videos/:videoId/view', summary: 'Count a view (one per viewer per day)', tag: 'videos', auth: 'optional', status: 204, rateLimit: { max: 120, timeWindow: '1 minute' } },
    async (ctx) => {
      const { row } = await visibleVideo(ctx.deps, ctx.actor, ctx.params.videoId!);
      const day = ctx.deps.now().toISOString().slice(0, 10);
      // Signed-out viewers are counted by a daily salted hash, so no raw IP is stored.
      const viewerKey = ctx.actor?.userId ?? viewerHash(ctx.deps, `${ctx.req.ip}|${ctx.req.headers['user-agent'] ?? ''}`, day);
      const counted = await ctx.deps.db.insertInto('video_views').values({ video_id: row.id, viewer_key: viewerKey, day })
        .onConflict((oc) => oc.columns(['video_id', 'viewer_key', 'day']).doNothing()).returning('video_id').executeTakeFirst();
      // One analytics event per counted view, like the view counter itself.
      if (counted) await ctx.track('video_viewed', { videoId: row.id });
    },
  ),

  route(
    { method: 'get', path: '/v1/me/videos', summary: 'My videos in every state', tag: 'videos', auth: 'user', query: CursorQuery, response: VideoPage },
    async (ctx) => {
      const me = ctx.me();
      let q = videoQuery(ctx.deps.db).where('videos.owner_user_id', '=', me.userId).where('videos.status', '!=', 'deleted');
      if (ctx.query.cursor) {
        const c = decodeCursor(ctx.query.cursor);
        q = q.where(sql<boolean>`(videos.created_at, videos.id) < (${c.at}, ${c.id}::uuid)`);
      }
      const rows = await q.orderBy('videos.created_at', 'desc').orderBy('videos.id', 'desc').limit(ctx.query.limit + 1).execute();
      const items = rows.slice(0, ctx.query.limit);
      const last = items.at(-1);
      return { items: await toVideoViews(ctx.deps, me, items), nextCursor: rows.length > ctx.query.limit && last ? encodeCursor(last.created_at, last.id) : null };
    },
  ),
];

function viewerHash(deps: Deps, raw: string, day: string) {
  return 'anon:' + createHmac('sha256', deps.config.VIEWER_HASH_SECRET).update(`${day}|${raw}`).digest('hex').slice(0, 32);
}
