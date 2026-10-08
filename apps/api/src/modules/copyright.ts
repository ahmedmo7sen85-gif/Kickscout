import { z } from 'zod';
import { CopyrightTakedownRequest, CopyrightTakedownResponse, CounterNoticeRequest } from '@fp/contracts';
import { isMinor } from '@fp/domain';
import { route } from '../platform/route.js';
import { ApiError, conflict, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { audit, emit } from '../platform/events.js';
import { ageBandOf } from '../platform/actor.js';
import { openCase } from './moderation.js';

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Takedown claims ahead of ordinary reports; anything about a minor's video goes first. */
const CLAIM_PRIORITY = 1;

export const copyrightRoutes = [
  route(
    { method: 'post', path: '/v1/copyright/takedowns', summary: 'Ask for a video to be taken down for copyright (no account needed)', tag: 'safety', auth: 'optional', body: CopyrightTakedownRequest, response: CopyrightTakedownResponse, status: 202, rateLimit: { max: 5, timeWindow: '1 hour' } },
    async (ctx) => {
      const b = ctx.body;
      const match = UUID_IN_TEXT.exec(b.video);
      if (!match) throw new ApiError(400, 'VIDEO_REQUIRED', 'give the link to the video or its id');
      const video = await ctx.deps.db.selectFrom('videos').select(['id', 'owner_user_id']).where('id', '=', match[0].toLowerCase()).where('status', '!=', 'deleted').executeTakeFirst();
      if (!video) throw notFound('video');
      const band = await ageBandOf(ctx.deps.db, video.owner_user_id);
      const claimId = newId();
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.insertInto('copyright_claims').values({
          id: claimId, video_id: video.id, claimant_name: b.claimantName, claimant_email: b.email, claimant_user_id: ctx.actor?.userId ?? null,
          description: b.description, good_faith: b.goodFaith, accurate: b.accurate,
        }).execute();
        // Joins the video's open case if there is one, otherwise opens a priority case.
        await openCase(tx, { targetKind: 'video', targetId: video.id, source: 'copyright', categories: ['copyright'], priority: !band || isMinor(band) ? 0 : CLAIM_PRIORITY });
        // The claimant's contact details stay in the claim; the audit log only points at it.
        await audit(tx, { actorId: ctx.actor?.userId ?? null, action: 'copyright.claim_received', targetKind: 'video', targetId: video.id, metadata: { claimId } });
        await emit(tx, 'copyright.claim_received', { claimId, videoId: video.id });
      });
      return { claimId, status: 'received' as const };
    },
  ),

  route(
    { method: 'post', path: '/v1/videos/:videoId/counter-notice', summary: 'The uploader (or a minor’s guardian) disputes a copyright removal', tag: 'safety', auth: 'user', body: CounterNoticeRequest, status: 202, rateLimit: { max: 5, timeWindow: '1 day' } },
    async (ctx) => {
      const me = ctx.me();
      const id = z.uuid().safeParse(ctx.params.videoId);
      if (!id.success) throw notFound('video');
      const video = await ctx.deps.db.selectFrom('videos').select(['id', 'owner_user_id', 'status']).where('id', '=', id.data).executeTakeFirst();
      // Someone else's video looks missing rather than forbidden.
      if (!video || (video.owner_user_id !== me.userId && !me.guardianOf.includes(video.owner_user_id))) throw notFound('video');
      const band = await ageBandOf(ctx.deps.db, video.owner_user_id);
      ctx.authorize({ kind: 'copyright.counter_notice', ownerId: video.owner_user_id, ownerMinor: !band || isMinor(band) });
      const upheld = await ctx.deps.db.selectFrom('copyright_claims').select('id').where('video_id', '=', video.id).where('status', '=', 'upheld').executeTakeFirst();
      if (video.status === 'deleted' || !upheld) throw new ApiError(409, 'NOT_REMOVED_FOR_COPYRIGHT', 'this video was not removed after a copyright claim');
      const b = ctx.body;
      await ctx.deps.db.transaction().execute(async (tx) => {
        const res = await tx.insertInto('copyright_counter_notices').values({
          id: newId(), video_id: video.id, submitted_by: me.userId, full_name: b.fullName, explanation: b.explanation, good_faith: b.goodFaith,
        }).onConflict((oc) => oc.column('video_id').where('status', '=', 'pending').doNothing()).returning('id').executeTakeFirst();
        if (!res) throw conflict('ALREADY_PENDING', 'a counter-notice for this video is already being reviewed');
        await openCase(tx, { targetKind: 'video', targetId: video.id, source: 'appeal', categories: ['copyright_counter_notice'], priority: CLAIM_PRIORITY });
        await audit(tx, { actorId: me.userId, action: 'copyright.counter_notice', targetKind: 'video', targetId: video.id, metadata: { noticeId: res.id } });
      });
    },
  ),
];
