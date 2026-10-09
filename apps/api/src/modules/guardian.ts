import { z } from 'zod';
import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import type { Database, DB } from '@fp/db';
import {
  AppealRequest, AppealView, CasePreview, GuardianCaseDetails, GuardianMetricsQuery, GuardianMetricsView, PolicyRescanRequest, RescanQueued,
} from '@fp/contracts';
import { DEFAULT_GUARDIAN_POLICY, GUARDIAN_CATEGORIES, REPORT_REASON_CATEGORY, mergePolicy } from '@fp/domain';
import type { Actor, GuardianPolicy } from '@fp/domain';
import { estimateCostUsd } from '@fp/ai';
import { route } from '../platform/route.js';
import { ApiError, conflict, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { mediaUrl } from '../platform/storage.js';
import { audit, enqueue } from '../platform/events.js';
import { canBeAppealed, wakeWorker } from './media.js';

/**
 * KICKSCOUT Guardian on the API side. The worker scans every upload; the API enforces the outcome
 * (nothing unapproved is listed or played publicly, see media.ts), runs the human review actions,
 * appeals, reports-driven restriction, re-scans and quality metrics. Every action is audited.
 */

let cachedPolicy: GuardianPolicy | null = null;
/** The same GUARDIAN_POLICY override the worker reads, for the few thresholds the API applies. */
export function guardianPolicy(): GuardianPolicy {
  if (!cachedPolicy) {
    let override: unknown = null;
    try {
      override = process.env.GUARDIAN_POLICY ? JSON.parse(process.env.GUARDIAN_POLICY) : null;
    } catch {
      override = null;
    }
    cachedPolicy = mergePolicy(DEFAULT_GUARDIAN_POLICY, override);
  }
  return cachedPolicy;
}

/** Case categories (Guardian categories, report reasons, not_football) that can carry a strike. */
export function strikeCategories(categories: readonly string[]): string[] {
  const out = new Set<string>();
  for (const c of categories) {
    if ((GUARDIAN_CATEGORIES as readonly string[]).includes(c) || c === 'not_football') out.add(c);
    const mapped = REPORT_REASON_CATEGORY[c];
    if (mapped) out.add(mapped);
  }
  return [...out];
}

/** Takes a published video out of public view while a person looks at it. */
export async function holdForReview(tx: Transaction<DB>, videoId: string) {
  const v = await tx.updateTable('videos')
    .set({ status: 'review_required', safety_status: 'HUMAN_REVIEW' })
    .where('id', '=', videoId).where('status', '=', 'published')
    .returning('id').executeTakeFirst();
  if (v) await enqueue(tx, 'video.unpublish', { videoId });
  return Boolean(v);
}

/** While a child-safety case is investigated the account cannot upload. */
export async function holdUploads(tx: Transaction<DB>, userId: string, now: Date, days = 3650, reason = 'Safety investigation') {
  const until = new Date(now.getTime() + days * 86_400_000);
  await tx.updateTable('users').set({ upload_restricted_until: until, upload_restriction_reason: reason })
    .where('id', '=', userId)
    .where((eb) => eb.or([eb('upload_restricted_until', 'is', null), eb('upload_restricted_until', '<', until)]))
    .execute();
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Guardian evidence for the video cases on a page of the moderation queue. */
export async function guardianDetails(db: Database, cases: { id: string; target_kind: string; target_id: string }[], now: Date) {
  const videoIds = cases.filter((c) => c.target_kind === 'video').map((c) => c.target_id);
  const out = new Map<string, z.input<typeof GuardianCaseDetails>>();
  if (videoIds.length === 0) return out;
  const [videos, results, reports, decided, appeals] = await Promise.all([
    db.selectFrom('videos').innerJoin('users', 'users.id', 'videos.owner_user_id')
      .select(['videos.id', 'videos.owner_user_id', 'videos.safety_status', 'videos.legal_hold', 'users.upload_restricted_until', 'users.status as owner_status'])
      .where('videos.id', 'in', videoIds).execute(),
    db.selectFrom('video_moderation_results').selectAll().where('video_id', 'in', videoIds).orderBy('created_at', 'desc').orderBy('id', 'desc').execute(),
    db.selectFrom('reports').select(['target_id', 'reason', 'details', 'status', 'created_at']).where('target_kind', '=', 'video').where('target_id', 'in', videoIds).orderBy('created_at', 'desc').execute(),
    db.selectFrom('moderation_cases').select(['target_id', 'decision', 'decision_note', 'decided_at']).where('target_kind', '=', 'video').where('target_id', 'in', videoIds).where('status', '!=', 'open').orderBy('decided_at', 'desc').execute(),
    db.selectFrom('moderation_appeals').select(['id', 'video_id', 'explanation', 'status', 'created_at']).where('video_id', 'in', videoIds).orderBy('created_at', 'desc').execute(),
  ]);
  const owners = [...new Set(videos.map((v) => v.owner_user_id))];
  const strikes = owners.length
    ? await db.selectFrom('account_strikes').select(['user_id', 'category', 'severity', 'created_at', 'expires_at'])
      .where('user_id', 'in', owners).where('voided_at', 'is', null).where('expires_at', '>', now).orderBy('created_at', 'desc').execute()
    : [];
  for (const v of videos) {
    out.set(v.id, {
      safetyStatus: v.safety_status as never,
      legalHold: v.legal_hold,
      scans: results.filter((r) => r.video_id === v.id).slice(0, 5).map((r) => ({
        id: r.id, scanKind: r.scan_kind as never, decision: r.decision as never, reasonCodes: r.reason_codes, detectedCategories: r.detected_categories,
        categoryProbabilities: (r.safety_scores ?? {}) as Record<string, number>, footballRelevance: num(r.football_relevance_score), confidence: num(r.confidence),
        suspiciousTimestamps: (r.suspicious_timestamps ?? []) as never, framesAnalyzed: r.frames_analyzed, stages: r.stages, explanation: r.explanation,
        modelVersion: r.model_version, policyVersion: r.policy_version, latencyMs: r.latency_ms, createdAt: r.created_at.toISOString(),
      })),
      owner: {
        userId: v.owner_user_id,
        activeStrikes: strikes.filter((s) => s.user_id === v.owner_user_id).map((s) => ({
          category: s.category, severity: s.severity as never, createdAt: s.created_at.toISOString(), expiresAt: s.expires_at.toISOString(),
        })),
        uploadRestrictedUntil: v.upload_restricted_until && v.upload_restricted_until > now ? v.upload_restricted_until.toISOString() : null,
        status: v.owner_status,
      },
      reports: reports.filter((r) => r.target_id === v.id).slice(0, 20).map((r) => ({ reason: r.reason, details: r.details, status: r.status, createdAt: r.created_at.toISOString() })),
      previousDecisions: decided.filter((d) => d.target_id === v.id).slice(0, 10).map((d) => ({ decision: d.decision, note: d.decision_note, decidedAt: iso(d.decided_at) })),
      appeal: (() => {
        const a = appeals.find((x) => x.video_id === v.id);
        return a ? { id: a.id, explanation: a.explanation, status: a.status as never, createdAt: a.created_at.toISOString() } : null;
      })(),
    });
  }
  return out;
}

/** Only admins work child-safety cases; to everyone else they do not exist. */
export function assertCaseAccess(me: Actor, c: { restricted: boolean }) {
  if (c.restricted && !me.roles.includes('admin')) throw notFound('case');
}

const ratio = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 10_000) / 10_000);

export const guardianRoutes = [
  route(
    { method: 'get', path: '/v1/admin/moderation-cases/:caseId/preview', summary: 'Short-lived signed links to the media of a case under review (audited)', tag: 'admin', auth: 'user', response: CasePreview },
    async (ctx) => {
      ctx.authorize({ kind: 'moderation.act' });
      const me = ctx.me();
      const c = await ctx.deps.db.selectFrom('moderation_cases').selectAll().where('id', '=', z.uuid().parse(ctx.params.caseId)).executeTakeFirst();
      if (!c || c.target_kind !== 'video') throw notFound('case');
      assertCaseAccess(me, c);
      const v = await ctx.deps.db.selectFrom('videos').selectAll().where('id', '=', c.target_id).executeTakeFirst();
      if (!v) throw notFound('video');
      // Suspected child sexual abuse material is never displayed in the tool; it goes through the reporting process.
      if (v.legal_hold) throw new ApiError(403, 'LEGAL_HOLD', 'this media is under legal hold and cannot be viewed here');
      const ttl = 300;
      const sign = async (key: string | null, deliveryKey: string | null) => {
        if (key) return (await ctx.deps.storage.presignGet(key, ttl)).url;
        return deliveryKey ? mediaUrl(ctx.deps.config.CDN_BASE_URL, deliveryKey) : null;
      };
      const [playbackUrl, thumbnailUrl] = await Promise.all([sign(v.quarantine_playback_key, v.playback_key), sign(v.quarantine_thumbnail_key, v.thumbnail_key)]);
      await ctx.deps.db.transaction().execute((tx) => audit(tx, { actorId: me.userId, action: 'moderation.preview', targetKind: 'video', targetId: v.id, caseId: c.id }));
      return { playbackUrl, thumbnailUrl, expiresAt: new Date(ctx.deps.now().getTime() + ttl * 1000).toISOString() };
    },
  ),

  route(
    { method: 'post', path: '/v1/admin/videos/:videoId/rescan', summary: 'Run the Guardian scan again on a stored video', tag: 'admin', auth: 'user', response: RescanQueued, status: 202 },
    async (ctx) => {
      ctx.authorize({ kind: 'moderation.act' });
      const videoId = z.uuid().parse(ctx.params.videoId);
      const v = await ctx.deps.db.selectFrom('videos').select(['id', 'status', 'legal_hold']).where('id', '=', videoId).where('status', '!=', 'deleted').executeTakeFirst();
      if (!v) throw notFound('video');
      if (v.legal_hold) throw new ApiError(409, 'LEGAL_HOLD', 'videos under legal hold are not sent for scanning again');
      await ctx.deps.db.transaction().execute(async (tx) => {
        await enqueue(tx, 'video.rescan', { videoId, kind: 'rescan' });
        await audit(tx, { actorId: ctx.me().userId, action: 'guardian.rescan_requested', targetKind: 'video', targetId: videoId });
      });
      await wakeWorker(ctx.deps, ctx.req.log);
      return { queued: 1 };
    },
  ),

  route(
    { method: 'post', path: '/v1/admin/guardian/rescan', summary: 'Re-check published videos after a policy or model update', tag: 'admin', auth: 'user', body: PolicyRescanRequest, response: RescanQueued, status: 202 },
    async (ctx) => {
      ctx.authorize({ kind: 'admin.access' });
      const { policyVersion, limit } = ctx.body;
      const queued = await ctx.deps.db.transaction().execute(async (tx) => {
        const { rows } = await sql<{ id: string }>`
          SELECT v.id FROM videos v
          LEFT JOIN LATERAL (SELECT policy_version FROM video_moderation_results r WHERE r.video_id = v.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) last ON true
          WHERE v.status = 'published' AND v.legal_hold = false AND (last.policy_version IS NULL OR last.policy_version <> ${policyVersion})
          ORDER BY v.published_at DESC NULLS LAST
          LIMIT ${limit}`.execute(tx);
        if (rows.length) {
          await tx.insertInto('jobs').values(rows.map((r) => ({ kind: 'video.rescan', payload: JSON.stringify({ videoId: r.id, kind: 'policy_update' }) }))).execute();
        }
        await audit(tx, { actorId: ctx.me().userId, action: 'guardian.policy_rescan', metadata: { policyVersion, queued: rows.length } });
        return rows.length;
      });
      if (queued) await wakeWorker(ctx.deps, ctx.req.log);
      return { queued };
    },
  ),

  route(
    { method: 'get', path: '/v1/admin/guardian/metrics', summary: 'Guardian quality and cost over a window', tag: 'admin', auth: 'user', query: GuardianMetricsQuery, response: GuardianMetricsView },
    async (ctx) => {
      ctx.authorize({ kind: 'moderation.act' });
      const db = ctx.deps.db;
      const since = new Date(ctx.deps.now().getTime() - ctx.query.days * 86_400_000);
      const [uploads, costs, reviewed, reversed, appeals, reasons, versions] = await Promise.all([
        db.selectFrom('video_moderation_results').select(['decision', db.fn.countAll<string>().as('n'), db.fn.avg<string>('latency_ms').as('latency')])
          .where('scan_kind', '=', 'upload').where('created_at', '>=', since).groupBy('decision').execute(),
        db.selectFrom('ai_calls').select([sql<string>`coalesce(response_model, model)`.as('m'), db.fn.sum<string>('input_tokens').as('i'), db.fn.sum<string>('output_tokens').as('o'),
          sql<string>`count(DISTINCT video_id)`.as('videos')])
          .where('task', 'in', ['video_screening', 'video_analysis']).where('created_at', '>=', since).groupBy(sql`coalesce(response_model, model)`).execute(),
        db.selectFrom('moderation_cases').select(['decision', db.fn.countAll<string>().as('n')])
          .where('target_kind', '=', 'video').where('source', '=', 'ai').where('decided_at', '>=', since).where('decision', 'in', ['approve', 'reject', 'remove'])
          .groupBy('decision').execute(),
        sql<{ removed: string; overturned: string }>`
          SELECT
            (SELECT count(*) FROM moderation_cases c JOIN videos v ON v.id = c.target_id
              WHERE c.target_kind = 'video' AND c.decision IN ('reject', 'remove', 'suspend') AND c.decided_at >= ${since}
                AND EXISTS (SELECT 1 FROM video_moderation_results r WHERE r.video_id = v.id AND r.scan_kind = 'upload' AND r.decision = 'APPROVED')) AS removed,
            (SELECT count(*) FROM moderation_appeals a WHERE a.status = 'overturned' AND a.decided_at >= ${since}) AS overturned`.execute(db),
        db.selectFrom('moderation_appeals').select(['status', db.fn.countAll<string>().as('n')]).where('created_at', '>=', since).groupBy('status').execute(),
        sql<{ code: string; n: string }>`
          SELECT code, count(*) AS n FROM video_moderation_results, unnest(reason_codes) AS code
          WHERE created_at >= ${since} GROUP BY code ORDER BY count(*) DESC, code LIMIT 10`.execute(db),
        db.selectFrom('video_moderation_results').select('policy_version').distinct().where('created_at', '>=', since).execute(),
      ]);
      const decisions = Object.fromEntries(uploads.map((u) => [u.decision, Number(u.n)]));
      const total = uploads.reduce((a, u) => a + Number(u.n), 0);
      const latencySum = uploads.reduce((a, u) => a + Number(u.latency ?? 0) * Number(u.n), 0);
      const spend = costs.reduce((a, c) => a + estimateCostUsd(c.m, Number(c.i ?? 0), Number(c.o ?? 0)), 0);
      const scanned = Math.max(0, ...costs.map((c) => Number(c.videos)));
      const r = Object.fromEntries(reviewed.map((x) => [x.decision, Number(x.n)]));
      const a = Object.fromEntries(appeals.map((x) => [x.status, Number(x.n)]));
      const rejectedAuto = decisions.REJECTED ?? 0;
      const overturned = Number(reversed.rows[0]?.overturned ?? 0);
      return {
        days: ctx.query.days,
        uploadsScanned: total,
        decisions,
        humanReviewRate: ratio(decisions.HUMAN_REVIEW ?? 0, total),
        scanFailureRate: ratio(decisions.SCAN_FAILED ?? 0, total),
        averageLatencyMs: total ? Math.round(latencySum / total) : null,
        averageCostUsd: scanned ? Math.round((spend / scanned) * 10_000) / 10_000 : null,
        reviewed: { approved: r.approve ?? 0, rejected: (r.reject ?? 0) + (r.remove ?? 0) },
        automaticReversed: { approvalsRemoved: Number(reversed.rows[0]?.removed ?? 0), rejectionsOverturned: overturned },
        appealReversalRate: ratio(a.overturned ?? 0, (a.overturned ?? 0) + (a.upheld ?? 0)),
        estimatedPrecision: rejectedAuto >= 20 ? ratio(rejectedAuto - overturned, rejectedAuto) : null,
        topReasonCodes: reasons.rows.map((x) => ({ code: x.code, count: Number(x.n) })),
        policyVersions: versions.map((v) => v.policy_version).sort(),
      };
    },
  ),

  route(
    { method: 'post', path: '/v1/videos/:videoId/appeal', summary: 'Appeal a Guardian rejection or removal (owner or guardian)', tag: 'videos', auth: 'user', body: AppealRequest, response: AppealView, status: 201, rateLimit: { max: 10, timeWindow: '1 day' } },
    async (ctx) => {
      const me = ctx.me();
      const videoId = z.uuid().safeParse(ctx.params.videoId);
      if (!videoId.success) throw notFound('video');
      const v = await ctx.deps.db.selectFrom('videos').selectAll().where('id', '=', videoId.data).where('status', '!=', 'deleted').executeTakeFirst();
      if (!v || !(v.owner_user_id === me.userId || me.guardianOf.includes(v.owner_user_id))) throw notFound('video');
      if (!canBeAppealed(v)) throw new ApiError(409, 'NOT_APPEALABLE', 'this video cannot be appealed');
      const id = newId();
      const now = ctx.deps.now();
      await ctx.deps.db.transaction().execute(async (tx) => {
        const pending = await tx.selectFrom('moderation_appeals').select('id').where('video_id', '=', v.id).where('status', '=', 'pending').executeTakeFirst();
        if (pending) throw conflict('APPEAL_PENDING', 'an appeal for this video is already waiting');
        const categories = (await tx.selectFrom('video_moderation_results').select('detected_categories').where('video_id', '=', v.id).orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst())?.detected_categories ?? [];
        const caseRow = await sql<{ id: string }>`
          INSERT INTO moderation_cases (id, target_kind, target_id, source, categories, priority, user_id, reason, appeal_status)
          VALUES (${newId()}, 'video', ${v.id}, 'appeal', ${['appeal', ...categories]}, 2, ${v.owner_user_id}, 'Appeal by the uploader', 'requested')
          ON CONFLICT (target_kind, target_id) WHERE status = 'open' DO UPDATE SET appeal_status = 'requested',
            categories = ARRAY(SELECT DISTINCT unnest(moderation_cases.categories || EXCLUDED.categories) ORDER BY 1)
          RETURNING id`.execute(tx);
        const caseId = caseRow.rows[0]!.id;
        await tx.insertInto('moderation_appeals').values({ id, video_id: v.id, user_id: me.userId, case_id: caseId, explanation: ctx.body.explanation }).execute();
        await audit(tx, { actorId: me.userId, action: 'moderation.appeal_requested', targetKind: 'video', targetId: v.id, caseId, metadata: { appealId: id } });
      });
      return { id, videoId: v.id, status: 'pending' as const, createdAt: now.toISOString() };
    },
  ),
];

/**
 * After a report on a video: the Guardian looks again, and a child-safety or sexual-content report,
 * or enough distinct reporters, takes a published video out of public view until a person decides.
 */
export async function onVideoReported(tx: Transaction<DB>, videoId: string, reason: string, now: Date) {
  const policy = guardianPolicy();
  const v = await tx.selectFrom('videos').select(['id', 'status', 'owner_user_id', 'legal_hold']).where('id', '=', videoId).executeTakeFirst();
  if (!v || v.status === 'deleted') return { restricted: false };
  const reporters = await tx.selectFrom('reports').select(sql<string>`count(DISTINCT reporter_id)`.as('n'))
    .where('target_kind', '=', 'video').where('target_id', '=', videoId).where('status', '=', 'open').executeTakeFirstOrThrow();
  const severe = reason === 'child_safety' || reason === 'sexual';
  const many = Number(reporters.n) >= policy.reportsToRestrict;
  let restricted = false;
  if (severe || many) restricted = await holdForReview(tx, videoId);
  if (reason === 'child_safety') {
    await tx.updateTable('moderation_cases').set({ restricted: true, priority: 0 })
      .where('target_kind', '=', 'video').where('target_id', '=', videoId).where('status', '=', 'open').execute();
  }
  // A fresh scan on the first report and whenever the video is pulled; never for media under legal hold.
  if (!v.legal_hold && (restricted || Number(reporters.n) === 1)) await enqueue(tx, 'video.rescan', { videoId, kind: 'report' });
  if (restricted) {
    await audit(tx, { actorId: null, action: 'guardian.restricted_after_reports', targetKind: 'video', targetId: videoId, metadata: { reason, reporters: Number(reporters.n), at: now.toISOString() } });
  }
  return { restricted };
}

