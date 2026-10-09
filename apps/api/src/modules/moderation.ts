import { z } from 'zod';
import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import type { Database, DB } from '@fp/db';
import {
  CopyrightClaimView, CounterNoticeView, UserStatusRequest,
  AdminStats, AuditLogPage, JurisdictionRuleRequest, ModerationCaseList, ModerationCaseQuery,
  ModerationDecisionRequest, VerificationDecisionRequest, VerificationRequestList,
} from '@fp/contracts';
import { route } from '../platform/route.js';
import { ApiError, conflict, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { audit, emit, notify } from '../platform/events.js';
import { toVideoViews, videoQuery } from './media.js';
import { runSavedSearchAlerts } from '@fp/worker/alerts';

/** Opens a moderation case, or merges into the open case for the same target. */
export async function openCase(
  tx: Transaction<DB>,
  c: { targetKind: 'video' | 'comment' | 'user' | 'organization'; targetId: string; source: 'ai' | 'rules' | 'report' | 'appeal' | 'copyright'; categories: string[]; priority: number; reports?: number; aiVerdict?: unknown },
) {
  await tx.insertInto('moderation_cases').values({
    id: newId(), target_kind: c.targetKind, target_id: c.targetId, source: c.source, categories: c.categories, priority: c.priority,
    report_count: c.reports ?? 0, ai_verdict: c.aiVerdict === undefined ? null : JSON.stringify(c.aiVerdict),
  }).onConflict((oc) => oc.columns(['target_kind', 'target_id']).where('status', '=', 'open').doUpdateSet((eb) => ({
    categories: sql<string[]>`ARRAY(SELECT DISTINCT unnest(${eb.ref('moderation_cases.categories')} || ${eb.ref('excluded.categories')}))`,
    priority: sql<number>`LEAST(${eb.ref('moderation_cases.priority')}, ${eb.ref('excluded.priority')})`,
    report_count: sql<number>`${eb.ref('moderation_cases.report_count')} + ${eb.ref('excluded.report_count')}`,
  }))).execute();
}

/**
 * Settles the copyright side of a moderation decision on a video. Removing, rejecting, restricting
 * or suspending upholds open claims (each counts towards the uploader's repeat-infringer total);
 * approving or dismissing rejects them. A pending counter-notice is accepted when the video is
 * approved again (its upheld claims are reversed) and rejected otherwise.
 */
export async function settleCopyright(tx: Transaction<DB>, videoId: string, decision: string, now: Date) {
  const removed = decision === 'remove' || decision === 'reject' || decision === 'restrict' || decision === 'suspend';
  await tx.updateTable('copyright_claims').set({ status: removed ? 'upheld' : 'rejected', decided_at: now })
    .where('video_id', '=', videoId).where('status', '=', 'open').execute();
  const notice = await tx.selectFrom('copyright_counter_notices').select('id').where('video_id', '=', videoId).where('status', '=', 'pending').executeTakeFirst();
  if (!notice) return;
  const accepted = decision === 'approve';
  await tx.updateTable('copyright_counter_notices').set({ status: accepted ? 'accepted' : 'rejected', decided_at: now }).where('id', '=', notice.id).execute();
  if (accepted) {
    await tx.updateTable('copyright_claims').set({ status: 'reversed', decided_at: now }).where('video_id', '=', videoId).where('status', '=', 'upheld').execute();
  }
}

/** Copyright claims, counter-notices and the owner's repeat-infringer count for a page of cases. */
async function copyrightContext(db: Database, cases: { target_kind: string; target_id: string }[]) {
  const videoIds = cases.filter((c) => c.target_kind === 'video').map((c) => c.target_id);
  const commentIds = cases.filter((c) => c.target_kind === 'comment').map((c) => c.target_id);
  const [claims, notices, videoOwners, commentAuthors] = await Promise.all([
    videoIds.length ? db.selectFrom('copyright_claims').selectAll().where('video_id', 'in', videoIds).orderBy('created_at', 'desc').execute() : Promise.resolve([]),
    videoIds.length ? db.selectFrom('copyright_counter_notices').selectAll().where('video_id', 'in', videoIds).orderBy('created_at', 'desc').execute() : Promise.resolve([]),
    videoIds.length ? db.selectFrom('videos').select(['id', 'owner_user_id']).where('id', 'in', videoIds).execute() : Promise.resolve([]),
    commentIds.length ? db.selectFrom('comments').select(['id', 'author_id']).where('id', 'in', commentIds).execute() : Promise.resolve([]),
  ]);
  const ownerOf = new Map<string, string>([...videoOwners.map((v) => [v.id, v.owner_user_id] as const), ...commentAuthors.map((c) => [c.id, c.author_id] as const)]);
  for (const c of cases) if (c.target_kind === 'user') ownerOf.set(c.target_id, c.target_id);
  const owners = [...new Set(ownerOf.values())];
  const strikes = owners.length
    ? await db.selectFrom('copyright_claims').innerJoin('videos', 'videos.id', 'copyright_claims.video_id')
      .select(['videos.owner_user_id', db.fn.count<string>('copyright_claims.video_id').distinct().as('n')])
      .where('copyright_claims.status', '=', 'upheld').where('videos.owner_user_id', 'in', owners).groupBy('videos.owner_user_id').execute()
    : [];
  const strikeMap = new Map(strikes.map((s) => [s.owner_user_id, Number(s.n)]));
  const claimMap = new Map<string, z.input<typeof CopyrightClaimView>[]>();
  for (const cl of claims) {
    (claimMap.get(cl.video_id) ?? claimMap.set(cl.video_id, []).get(cl.video_id)!).push({
      id: cl.id, claimantName: cl.claimant_name, claimantEmail: cl.claimant_email, description: cl.description, status: cl.status as never, createdAt: cl.created_at.toISOString(),
    });
  }
  const noticeMap = new Map<string, z.input<typeof CounterNoticeView>>();
  for (const n of notices) {
    if (!noticeMap.has(n.video_id)) noticeMap.set(n.video_id, { id: n.id, fullName: n.full_name, explanation: n.explanation, status: n.status as never, createdAt: n.created_at.toISOString() });
  }
  return {
    claims: claimMap,
    notices: noticeMap,
    strikesFor: (kind: string, id: string) => {
      const owner = kind === 'organization' ? undefined : ownerOf.get(id);
      return owner ? (strikeMap.get(owner) ?? 0) : null;
    },
  };
}

const StatusReason = {
  reject: 'Rejected by a moderator',
  remove: 'Removed by a moderator',
} as const;

export const moderationRoutes = [
  route(
    { method: 'get', path: '/v1/admin/stats', summary: 'Platform counters for the admin dashboard', tag: 'admin', auth: 'user', response: AdminStats },
    async (ctx) => {
      ctx.authorize({ kind: 'moderation.act' });
      const db = ctx.deps.db;
      const r = await db.selectNoFrom((eb) => [
        eb.selectFrom('users').select(eb.fn.countAll<string>().as('n')).where('status', '!=', 'deleted').as('users'),
        eb.selectFrom('user_roles').select(eb.fn.countAll<string>().as('n')).where('role', '=', 'player').as('players'),
        eb.selectFrom('user_roles').select(eb.fn.countAll<string>().as('n')).where('role', '=', 'scout').as('scouts'),
        eb.selectFrom('videos').select(eb.fn.countAll<string>().as('n')).where('status', '=', 'published').as('videos'),
        eb.selectFrom('moderation_cases').select(eb.fn.countAll<string>().as('n')).where('status', '=', 'open').as('cases'),
        eb.selectFrom('verification_requests').select(eb.fn.countAll<string>().as('n')).where('status', '=', 'pending').as('verifications'),
        eb.selectFrom('jobs').select(eb.fn.countAll<string>().as('n')).where('status', '=', 'failed').as('failed'),
      ]).executeTakeFirstOrThrow();
      return {
        users: Number(r.users), players: Number(r.players), scouts: Number(r.scouts), videosPublished: Number(r.videos),
        openCases: Number(r.cases), pendingVerifications: Number(r.verifications), failedJobs: Number(r.failed),
      };
    },
  ),

  route(
    { method: 'get', path: '/v1/admin/moderation-cases', summary: 'Moderation queue, most urgent first', tag: 'admin', auth: 'user', query: ModerationCaseQuery, response: ModerationCaseList },
    async (ctx) => {
      ctx.authorize({ kind: 'moderation.act' });
      const me = ctx.me();
      const cases = await ctx.deps.db.selectFrom('moderation_cases').selectAll().where('status', '=', ctx.query.status)
        .orderBy('priority').orderBy('created_at').limit(ctx.query.limit).execute();
      const videoIds = cases.filter((c) => c.target_kind === 'video').map((c) => c.target_id);
      const commentIds = cases.filter((c) => c.target_kind === 'comment').map((c) => c.target_id);
      const orgIds = cases.filter((c) => c.target_kind === 'organization').map((c) => c.target_id);
      const [videoRows, comments, orgs] = await Promise.all([
        videoIds.length ? videoQuery(ctx.deps.db).where('videos.id', 'in', videoIds).execute() : Promise.resolve([]),
        commentIds.length
          ? ctx.deps.db.selectFrom('comments').innerJoin('profiles', 'profiles.user_id', 'comments.author_id')
            .select(['comments.id', 'comments.body', 'profiles.handle']).where('comments.id', 'in', commentIds).execute()
          : Promise.resolve([]),
        orgIds.length ? ctx.deps.db.selectFrom('organizations').select(['id', 'name', 'type', 'verified_at', 'status']).where('id', 'in', orgIds).execute() : Promise.resolve([]),
      ]);
      const orgMap = new Map(orgs.map((o) => [o.id, { id: o.id, name: o.name, type: o.type, verified: o.verified_at !== null, status: o.status }]));
      const videos = new Map((await toVideoViews(ctx.deps, me, videoRows)).map((v) => [v.id, v]));
      const aiModels = new Map((videoIds.length ? await ctx.deps.db.selectFrom('videos').select(['id', 'ai_model']).where('id', 'in', videoIds).execute() : []).map((v) => [v.id, v.ai_model]));
      const commentMap = new Map(comments.map((c) => [c.id, c]));
      const copyright = await copyrightContext(ctx.deps.db, cases);
      return {
        items: cases.map((c) => ({
          id: c.id, targetKind: c.target_kind as never, targetId: c.target_id, source: c.source as never, categories: c.categories,
          aiVerdict: c.ai_verdict ?? null, aiModel: aiModels.get(c.target_id) ?? null, reportCount: c.report_count, priority: c.priority, status: c.status as never,
          decision: c.decision, createdAt: c.created_at.toISOString(),
          video: videos.get(c.target_id) ?? null,
          comment: commentMap.has(c.target_id) ? { id: c.target_id, body: commentMap.get(c.target_id)!.body, authorHandle: commentMap.get(c.target_id)!.handle } : null,
          organization: c.target_kind === 'organization' ? (orgMap.get(c.target_id) ?? null) : null,
          copyrightClaims: copyright.claims.get(c.target_id) ?? [],
          counterNotice: copyright.notices.get(c.target_id) ?? null,
          ownerCopyrightStrikes: copyright.strikesFor(c.target_kind, c.target_id),
        })),
      };
    },
  ),

  route(
    { method: 'post', path: '/v1/admin/moderation-cases/:caseId/decision', summary: 'Decide a moderation case', tag: 'admin', auth: 'user', body: ModerationDecisionRequest, status: 204 },
    async (ctx) => {
      ctx.authorize({ kind: 'moderation.act' });
      const me = ctx.me();
      const { decision, note } = ctx.body;
      let published: string | null = null;
      let publishedOwner: string | null = null;
      await ctx.deps.db.transaction().execute(async (tx) => {
        const c = await tx.selectFrom('moderation_cases').selectAll().where('id', '=', z.uuid().parse(ctx.params.caseId)).forUpdate().executeTakeFirst();
        if (!c) throw notFound('case');
        if (c.status !== 'open') throw conflict('CASE_CLOSED', 'this case is already decided');
        const now = ctx.deps.now();

        if (decision === 'escalate') {
          await tx.updateTable('moderation_cases').set({ priority: 0 }).where('id', '=', c.id).execute();
          await audit(tx, { actorId: me.userId, action: 'moderation.escalate', targetKind: c.target_kind, targetId: c.target_id, metadata: { caseId: c.id, note: note ?? null } });
          return;
        }
        if (decision === 'suspend' && c.target_kind !== 'organization') {
          const ownerId = c.target_kind === 'user' ? c.target_id
            : c.target_kind === 'video' ? (await tx.selectFrom('videos').select('owner_user_id').where('id', '=', c.target_id).executeTakeFirst())?.owner_user_id
            : (await tx.selectFrom('comments').select('author_id').where('id', '=', c.target_id).executeTakeFirst())?.author_id;
          if (ownerId) await tx.updateTable('users').set({ status: 'suspended' }).where('id', '=', ownerId).where('status', '=', 'active').execute();
          if (c.target_kind === 'video') await tx.updateTable('videos').set({ status: 'rejected', moderation: 'rejected', status_reason: StatusReason.remove }).where('id', '=', c.target_id).where('status', '!=', 'deleted').execute();
          if (c.target_kind === 'comment') await tx.updateTable('comments').set({ moderation: 'removed' }).where('id', '=', c.target_id).execute();
        }
        if (c.target_kind === 'video' && decision !== 'dismiss' && decision !== 'suspend') {
          const v = await tx.selectFrom('videos').select(['id', 'owner_user_id', 'status', 'playback_key']).where('id', '=', c.target_id).executeTakeFirst();
          if (v && v.status !== 'deleted') {
            if (decision === 'approve') {
              // Only a fully processed video can be published.
              if (!v.playback_key) throw new ApiError(409, 'NOT_PROCESSED', 'this video has not finished processing');
              await tx.updateTable('videos').set({ status: 'published', moderation: 'safe', status_reason: null, published_at: now }).where('id', '=', v.id).execute();
              await notify(tx, v.owner_user_id, 'video.published', { videoId: v.id });
              published = v.id;
              publishedOwner = v.owner_user_id;
            } else if (decision === 'restrict') {
              await tx.updateTable('videos').set({ visibility: 'private' }).where('id', '=', v.id).execute();
              await notify(tx, v.owner_user_id, 'video.restricted', { videoId: v.id });
            } else {
              await tx.updateTable('videos').set({ status: 'rejected', moderation: 'rejected', status_reason: StatusReason[decision] }).where('id', '=', v.id).execute();
              await notify(tx, v.owner_user_id, 'video.rejected', { videoId: v.id });
            }
          }
        }
        if (c.target_kind === 'comment' && decision !== 'dismiss' && decision !== 'suspend') {
          await tx.updateTable('comments').set({ moderation: decision === 'approve' ? 'visible' : 'removed' }).where('id', '=', c.target_id).execute();
        }
        if (c.target_kind === 'user' && (decision === 'restrict' || decision === 'remove' || decision === 'reject')) {
          await tx.updateTable('users').set({ status: 'suspended' }).where('id', '=', c.target_id).where('status', '=', 'active').execute();
        }
        // An organization found to be fake or abusive is hidden from the public and its pipeline frozen; approve restores it.
        if (c.target_kind === 'organization' && decision !== 'dismiss') {
          const suspend = decision !== 'approve';
          const org = await tx.updateTable('organizations').set({ status: suspend ? 'suspended' : 'active', updated_at: now })
            .where('id', '=', c.target_id).where('status', '!=', 'deleted').returning('id').executeTakeFirst();
          const owner = org && await tx.selectFrom('organization_members').select('user_id').where('organization_id', '=', c.target_id).where('role', '=', 'owner').executeTakeFirst();
          if (owner && suspend) await notify(tx, owner.user_id, 'org.suspended', { organizationId: c.target_id });
        }
        if (c.target_kind === 'video') await settleCopyright(tx, c.target_id, decision, now);
        await tx.updateTable('moderation_cases').set({
          status: decision === 'dismiss' ? 'dismissed' : 'actioned', decision, decided_by: me.userId, decision_note: note ?? null, decided_at: now,
        }).where('id', '=', c.id).execute();
        await tx.updateTable('reports').set({ status: decision === 'dismiss' ? 'dismissed' : 'actioned' })
          .where('target_kind', '=', c.target_kind).where('target_id', '=', c.target_id).where('status', '=', 'open').execute();
        await audit(tx, { actorId: me.userId, action: `moderation.${decision}`, targetKind: c.target_kind, targetId: c.target_id, metadata: { caseId: c.id, note: note ?? null } });
      });
      // Saved-search alerts for the newly published clip, once it is committed. Best effort: the
      // worker's maintenance run catches up if this fails.
      if (published) {
        await runSavedSearchAlerts(ctx.deps.db, { videoIds: [published] }).catch((err: Error) => ctx.req.log.warn({ err }, 'saved-search alerts failed'));
        if (publishedOwner) await ctx.track('upload_published', { videoId: published }, { userId: publishedOwner });
      }
    },
  ),

  route(
    { method: 'post', path: '/v1/admin/users/:userId/status', summary: 'Suspend or restore a user', tag: 'admin', auth: 'user', body: UserStatusRequest, status: 204 },
    async (ctx) => {
      ctx.authorize({ kind: 'moderation.act' });
      const me = ctx.me();
      const userId = z.uuid().parse(ctx.params.userId);
      if (userId === me.userId) throw new ApiError(400, 'SELF_ACTION', 'you cannot change your own status');
      await ctx.deps.db.transaction().execute(async (tx) => {
        const target = await tx.selectFrom('users').select('status').where('id', '=', userId).executeTakeFirst();
        if (!target || target.status === 'deleted' || target.status === 'pending_consent') throw notFound('user');
        // Moderators cannot suspend admins.
        const targetAdmin = await tx.selectFrom('user_roles').select('role').where('user_id', '=', userId).where('role', '=', 'admin').executeTakeFirst();
        if (targetAdmin && !me.roles.includes('admin')) throw new ApiError(403, 'FORBIDDEN', 'only admins can change an admin');
        await tx.updateTable('users').set({ status: ctx.body.status }).where('id', '=', userId).execute();
        await audit(tx, { actorId: me.userId, action: ctx.body.status === 'suspended' ? 'user.suspended' : 'user.restored', targetKind: 'user', targetId: userId, metadata: { reason: ctx.body.reason } });
      });
    },
  ),

  route(
    { method: 'get', path: '/v1/admin/verification-requests', summary: 'Pending verification requests of every type (identity, player, scout, organization)', tag: 'admin', auth: 'user', response: VerificationRequestList },
    async (ctx) => {
      ctx.authorize({ kind: 'verification.decide' });
      const rows = await ctx.deps.db.selectFrom('verification_requests').innerJoin('profiles', 'profiles.user_id', 'verification_requests.user_id')
        .select(['verification_requests.id', 'verification_requests.user_id', 'verification_requests.kind', 'verification_requests.status',
          'verification_requests.organization', 'verification_requests.evidence', 'verification_requests.created_at', 'profiles.handle', 'profiles.display_name',
          'verification_requests.organization_id'])
        .where('verification_requests.status', '=', 'pending').orderBy('verification_requests.created_at').limit(100).execute();
      const orgIds = rows.flatMap((r) => (r.organization_id ? [r.organization_id] : []));
      const orgs = orgIds.length ? await ctx.deps.db.selectFrom('organizations').select(['id', 'name', 'type', 'country_code']).where('id', 'in', orgIds).execute() : [];
      const orgMap = new Map(orgs.map((o) => [o.id, { id: o.id, name: o.name, type: o.type, country: o.country_code }]));
      return {
        items: rows.map((r) => ({
          id: r.id, user: { userId: r.user_id, handle: r.handle, displayName: r.display_name }, kind: r.kind as never, status: r.status as never,
          organization: r.organization, evidence: r.evidence, createdAt: r.created_at.toISOString(),
          targetOrganization: r.organization_id ? (orgMap.get(r.organization_id) ?? null) : null,
        })),
      };
    },
  ),

  route(
    { method: 'post', path: '/v1/admin/verification-requests/:requestId/decision', summary: 'Approve or reject a verification request', tag: 'admin', auth: 'user', body: VerificationDecisionRequest, status: 204 },
    async (ctx) => {
      ctx.authorize({ kind: 'verification.decide' });
      const me = ctx.me();
      await ctx.deps.db.transaction().execute(async (tx) => {
        const r = await tx.selectFrom('verification_requests').selectAll().where('id', '=', z.uuid().parse(ctx.params.requestId)).forUpdate().executeTakeFirst();
        if (!r) throw notFound('verification request');
        if (r.status !== 'pending') throw conflict('ALREADY_DECIDED', 'this request is already decided');
        const now = ctx.deps.now();
        await tx.updateTable('verification_requests').set({ status: ctx.body.approve ? 'approved' : 'rejected', decided_by: me.userId, decided_at: now }).where('id', '=', r.id).execute();
        if (ctx.body.approve && r.kind === 'organization') {
          // The badge goes on the organization, not on the person who asked.
          await tx.updateTable('organizations').set({ verified_at: now, updated_at: now }).where('id', '=', r.organization_id!).execute();
        } else if (ctx.body.approve) {
          await tx.updateTable('profiles').set({ verified_at: now }).where('user_id', '=', r.user_id).execute();
          if (r.kind === 'scout') {
            await tx.insertInto('user_roles').values({ user_id: r.user_id, role: 'scout', granted_by: me.userId })
              .onConflict((oc) => oc.columns(['user_id', 'role']).doNothing()).execute();
          }
        }
        await notify(tx, r.user_id, ctx.body.approve ? 'verification.approved' : 'verification.rejected', { kind: r.kind, ...(r.organization_id ? { organizationId: r.organization_id } : {}) });
        await audit(tx, {
          actorId: me.userId, action: ctx.body.approve ? 'verification.approved' : 'verification.rejected',
          targetKind: r.organization_id ? 'organization' : 'user', targetId: r.organization_id ?? r.user_id, metadata: { kind: r.kind, requestId: r.id, userId: r.user_id },
        });
      });
    },
  ),

  route(
    { method: 'get', path: '/v1/admin/audit-logs', summary: 'Most recent audit entries', tag: 'admin', auth: 'user', query: z.object({ targetId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), response: AuditLogPage },
    async (ctx) => {
      ctx.authorize({ kind: 'admin.access' });
      let q = ctx.deps.db.selectFrom('audit_logs').selectAll().orderBy('id', 'desc').limit(ctx.query.limit);
      if (ctx.query.targetId) q = q.where('target_id', '=', ctx.query.targetId);
      const rows = await q.execute();
      // Reading the audit log is itself audited.
      await ctx.deps.db.transaction().execute((tx) => audit(tx, { actorId: ctx.me().userId, action: 'audit.read', metadata: { targetId: ctx.query.targetId ?? null } }));
      return {
        items: rows.map((r) => ({
          id: String(r.id), actorId: r.actor_id, action: r.action, targetKind: r.target_kind, targetId: r.target_id,
          metadata: r.metadata as Record<string, unknown>, createdAt: r.created_at.toISOString(),
        })),
      };
    },
  ),

  route(
    { method: 'put', path: '/v1/admin/jurisdiction-rules/:countryCode', summary: 'Set a country’s age rule (applies only once legally reviewed)', tag: 'admin', auth: 'user', body: JurisdictionRuleRequest, status: 204 },
    async (ctx) => {
      ctx.authorize({ kind: 'admin.access' });
      const country = z.string().regex(/^[A-Z]{2}$/).parse(ctx.params.countryCode);
      const b = ctx.body;
      await ctx.deps.db.transaction().execute(async (tx) => {
        const values = {
          minimum_age: b.minimumAge, guardian_consent_age: b.guardianConsentAge, legally_reviewed: b.legallyReviewed,
          source: b.source ?? null, updated_by: ctx.me().userId, updated_at: ctx.deps.now(),
        };
        await tx.insertInto('jurisdiction_rules').values({ country_code: country, ...values })
          .onConflict((oc) => oc.column('country_code').doUpdateSet(values)).execute();
        await audit(tx, { actorId: ctx.me().userId, action: 'jurisdiction.updated', metadata: { country, ...b } });
      });
    },
  ),
];
