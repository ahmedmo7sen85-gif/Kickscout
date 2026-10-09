import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { DB, Database } from '@fp/db';
import type { GuardianPolicy } from '@fp/domain';
import { MediaRejection } from './errors.js';
import { decodeCheck, probe, sha256File, thumbnail, transcode, validate } from './media.js';
import type { MediaTools, ProbeInfo, TrimWindow } from './media.js';
import { playbackKey, quarantinePlaybackKey, quarantineThumbnailKey, thumbnailKey } from './storage/storage.js';
import type { VideoStorage } from './storage/storage.js';
import { runSavedSearchAlerts } from './alerts.js';
import { recordServerEvent } from './analytics.js';
import { FootballVideoSafetyService } from './guardian/service.js';
import type { GuardianClassifiers, ScanResult } from './guardian/service.js';
import { applyStrike, auditEntry, holdUploadsForInvestigation, insertResult, routeToReview, USER_MESSAGES, userMessage } from './guardian/records.js';
import type { ScanKind } from './guardian/records.js';
import type { GuardianDecision } from './guardian/types.js';

/** Skill tags below this confidence are dropped; those kept are shown as AI suggestions, never as fact. */
export const MIN_TAG_CONFIDENCE = 0.4;

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface PipelineDeps {
  db: Database;
  storage: VideoStorage;
  /** The Guardian's classifiers; null when no AI is configured, and then nothing is ever auto-published. */
  classifiers: GuardianClassifiers | null;
  policy?: GuardianPolicy | undefined;
  media: MediaTools;
  maxOriginalBytes: number;
  workDir?: string | undefined;
  log: Logger;
  now?: () => Date;
}

export type ProcessResult =
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'published' | 'review_required' | 'rejected' | 'unchanged' | 'removed' };

type Applied = Exclude<ProcessResult['outcome'], 'skipped'>;

/** Statuses in which a video may be (re)processed; anything else means the job already ran or the video moved on. */
const ACTIVE = ['processing', 'analyzing'] as const;

type Db = Kysely<DB> | Transaction<DB>;
type VideoRow = Awaited<ReturnType<typeof loadVideo>>;

const isUrl = (k: string | null) => !!k && /^https?:\/\//.test(k);

async function notify(db: Db, userId: string, kind: string, payload: Record<string, unknown>) {
  await db.insertInto('notifications').values({ id: uuidv7(), user_id: userId, kind, payload: JSON.stringify(payload) }).execute();
}

function loadVideo(db: Db, videoId: string) {
  return db.selectFrom('videos').selectAll().where('id', '=', videoId).executeTakeFirst();
}

function guardian(deps: PipelineDeps) {
  return new FootballVideoSafetyService({ db: deps.db, media: deps.media, classifiers: deps.classifiers, policy: deps.policy, log: deps.log, ...(deps.now ? { now: deps.now } : {}) });
}

async function ownerIsMinor(db: Db, ownerId: string) {
  const age = await db.selectFrom('age_records').select('age_band').where('user_id', '=', ownerId).executeTakeFirst();
  return age?.age_band !== 'adult'; // unknown age is treated as a minor
}

async function metadataOf(db: Db, video: NonNullable<VideoRow>) {
  const tags = await db.selectFrom('video_hashtags').select('tag').where('video_id', '=', video.id).execute();
  return { title: video.title, description: video.description, hashtags: tags.map((t) => t.tag) };
}

function legacyModeration(d: GuardianDecision): 'safe' | 'flagged' | 'review_required' | 'rejected' {
  if (d.decision === 'APPROVED') return 'safe';
  if (d.decision === 'REJECTED') return 'rejected';
  return d.categories.length ? 'flagged' : 'review_required';
}

function aiSummary(scan: ScanResult) {
  const d = scan.decision;
  return JSON.stringify({
    available: scan.modelVersion !== null, model: scan.modelVersion, decision: d.decision, reasonCodes: d.reasonCodes,
    footballRelevance: d.footballRelevance, confidence: d.confidence, categoryProbabilities: d.categoryProbabilities,
    suspicious: d.suspicious, explanation: d.explanation,
    duplicateOf: scan.duplicates.exactRejected?.videoId ?? scan.duplicates.similarRejected?.videoId ?? scan.duplicates.otherOwnerDuplicate ?? null,
  });
}

/** Decisions on a not-yet-public upload that a person must see. A clear rejection needs no case until the player appeals. */
function needsCase(d: GuardianDecision, kind: ScanKind) {
  return d.decision !== 'APPROVED' && (d.decision !== 'REJECTED' || d.childSafety || kind !== 'upload');
}

// ---------------------------------------------------------------- upload

export async function processVideo(deps: PipelineDeps, videoId: string): Promise<ProcessResult> {
  const { db, log } = deps;
  const video = await loadVideo(db, videoId);
  if (!video) return { outcome: 'skipped', reason: 'video not found' };
  if (video.status === 'deleted' || video.deleted_at) return { outcome: 'skipped', reason: 'video deleted' };
  if (!(ACTIVE as readonly string[]).includes(video.status)) return { outcome: 'skipped', reason: `video is ${video.status}` };
  await db.updateTable('videos').set({ safety_status: 'PROCESSING' }).where('id', '=', videoId).where('status', 'in', ACTIVE).execute();
  const service = guardian(deps);

  const dir = await mkdtemp(path.join(deps.workDir ?? os.tmpdir(), `video-${videoId}-`));
  try {
    const original = path.join(dir, 'original');
    await deps.storage.downloadOriginal(video.original_key, original, deps.maxOriginalBytes);
    const sha256 = await sha256File(original);

    // ---- 1. integrity: type, size, length, resolution, a full decode
    let info: ProbeInfo | undefined;
    let trim: TrimWindow;
    try {
      info = await probe(deps.media, original);
      const decoded = await decodeCheck(deps.media, original);
      const fullMs = info.durationMs ?? decoded.decodedMs;
      if (!fullMs) throw new MediaRejection('The length of the video could not be determined.');
      trim = validate(info, fullMs, video.trim_start_ms, video.trim_end_ms, video.max_duration_ms);
    } catch (err) {
      if (!(err instanceof MediaRejection)) throw err;
      const changed = await db.transaction().execute(async (tx) => {
        const row = await tx.updateTable('videos')
          .set({
            status: 'rejected', safety_status: 'REJECTED', safety_checked_at: sql`now()`, status_reason: err.reason, sha256,
            ...(info ? { detected_format: info.format, width: info.width, height: info.height, duration_ms: info.durationMs } : {}),
          })
          .where('id', '=', videoId).where('status', 'in', ACTIVE).where('deleted_at', 'is', null)
          .returning('id').executeTakeFirst();
        if (!row) return false;
        const decision: GuardianDecision = {
          decision: 'REJECTED', reasonCodes: ['INTEGRITY_FAILED'], categories: [], categoryProbabilities: {}, footballRelevance: null, confidence: null,
          suspicious: [], childSafety: false, priority: 2, reviewRequired: false, explanation: err.reason,
        };
        await insertResult(tx, { videoId, scanKind: 'upload', decision, stages: ['integrity'], framesAnalyzed: 0, modelVersion: null, policyVersion: service.policy.version, latencyMs: null });
        await auditEntry(tx, { actorId: null, action: 'guardian.decision', videoId, metadata: { decision: 'REJECTED', reasonCodes: ['INTEGRITY_FAILED'] } });
        await notify(tx, video.owner_user_id, 'video.rejected', { videoId, reason: err.reason });
        return true;
      });
      log.info('video rejected by validation', { videoId, reason: err.reason });
      return changed ? { outcome: 'rejected', reason: err.reason } : { outcome: 'skipped', reason: 'video changed during validation' };
    }

    // ---- 2. transcode into private quarantine; nothing is public yet
    const playback = path.join(dir, 'playback.mp4');
    const thumb = path.join(dir, 'thumb.jpg');
    await transcode(deps.media, original, playback, trim);
    const out = await probe(deps.media, playback).catch(() => null);
    const outDurationMs = out?.durationMs ?? trim.durationMs;
    await thumbnail(deps.media, playback, thumb, outDurationMs);
    await deps.storage.uploadPrivate(quarantinePlaybackKey(videoId), playback, 'video/mp4');
    await deps.storage.uploadPrivate(quarantineThumbnailKey(videoId), thumb, 'image/jpeg');

    const moved = await db.updateTable('videos')
      .set({
        status: 'analyzing', detected_format: info.format, duration_ms: trim.durationMs, width: info.width, height: info.height, sha256,
        quarantine_playback_key: quarantinePlaybackKey(videoId), quarantine_thumbnail_key: quarantineThumbnailKey(videoId),
      })
      .where('id', '=', videoId).where('status', 'in', ACTIVE).where('deleted_at', 'is', null)
      .returning('id').executeTakeFirst();
    if (!moved) return { outcome: 'skipped', reason: 'video changed during processing' };

    // ---- 3. the Guardian scan
    const scan = await service.scan({
      videoId, ownerId: video.owner_user_id, ownerIsMinor: await ownerIsMinor(db, video.owner_user_id), path: playback, workDir: dir,
      durationMs: outDurationMs, width: out?.width ?? info.width, height: out?.height ?? info.height, hasAudio: out?.hasAudio ?? info.hasAudio,
      sha256, metadata: await metadataOf(db, video),
    });
    scan.stages.unshift('integrity');
    const result = await applyScan(deps, service, (await loadVideo(db, videoId))!, scan, { kind: 'upload', expectStatus: 'analyzing', playback, thumb });
    log.info('video processed', { videoId, decision: scan.decision.decision, reasons: scan.decision.reasonCodes });
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Applies a Guardian decision: the result row, the video's state, the review case, strikes and
 * enforcement, the audit trail and the owner's notice, in one transaction; then storage changes.
 * Publication happens only on APPROVED, only from the private copy, and only after the decision is stored.
 */
async function applyScan(
  deps: PipelineDeps,
  service: FootballVideoSafetyService,
  video: NonNullable<VideoRow>,
  scan: ScanResult,
  opts: { kind: ScanKind; expectStatus: string; playback?: string; thumb?: string },
): Promise<ProcessResult> {
  const { db, log } = deps;
  const d = scan.decision;
  const now = deps.now?.() ?? new Date();
  const upload = opts.kind === 'upload';
  const wasPublic = video.status === 'published';

  // Child safety: the processed copies made for review are deleted again; the original is kept under legal hold.
  if (d.childSafety && video.quarantine_playback_key && upload) {
    await deps.storage.deleteObjects('originals', [video.quarantine_playback_key, video.quarantine_thumbnail_key ?? quarantineThumbnailKey(video.id)])
      .catch((err: Error) => log.warn('could not remove quarantined copies', { videoId: video.id, error: err.message }));
  }
  // Approved uploads are copied to public delivery from the local files, before the row says "published".
  const publish = upload && d.decision === 'APPROVED' && opts.playback && opts.thumb;
  if (publish) {
    await deps.storage.uploadDelivery(playbackKey(video.id), opts.playback!, 'video/mp4');
    await deps.storage.uploadDelivery(thumbnailKey(video.id), opts.thumb!, 'image/jpeg');
  }

  let next: { status: string; safety: string; outcome: Applied };
  if (upload) {
    next = d.decision === 'APPROVED' ? { status: 'published', safety: 'APPROVED', outcome: 'published' }
      : d.decision === 'REJECTED' ? { status: 'rejected', safety: 'REJECTED', outcome: 'rejected' }
        : { status: 'review_required', safety: d.decision, outcome: 'review_required' };
  } else if (d.decision === 'APPROVED') {
    next = { status: video.status, safety: video.safety_status, outcome: 'unchanged' };
  } else if (d.decision === 'REJECTED') {
    next = { status: 'rejected', safety: wasPublic ? 'REMOVED' : 'REJECTED', outcome: wasPublic ? 'removed' : 'rejected' };
  } else {
    next = { status: video.status === 'published' ? 'review_required' : video.status, safety: d.decision, outcome: 'review_required' };
  }

  const applied = await db.transaction().execute(async (tx) => {
    const resultId = await insertResult(tx, {
      videoId: video.id, scanKind: opts.kind, decision: d, stages: scan.stages, framesAnalyzed: scan.framesAnalyzed,
      modelVersion: scan.modelVersion, policyVersion: service.policy.version, latencyMs: scan.latencyMs,
    });
    const deep = scan.deepFindings;
    const row = await tx.updateTable('videos')
      .set({
        status: next.status, safety_status: next.safety, safety_checked_at: now,
        status_reason: upload || next.outcome !== 'unchanged' ? (wasPublic && d.decision === 'REJECTED' ? USER_MESSAGES.removed : userMessage(d)) : video.status_reason,
        moderation: upload || d.decision !== 'APPROVED' ? legacyModeration(d) : video.moderation,
        ai_summary: aiSummary(scan),
        ai_model: scan.modelVersion,
        ...(deep ? { football_present: deep.footballRelevance >= 0.5, players_visible: deep.playersVisible } : {}),
        ...(publish ? { playback_key: playbackKey(video.id), thumbnail_key: thumbnailKey(video.id), published_at: sql`coalesce(published_at, now())` } : {}),
        ...(d.childSafety ? { legal_hold: true, ...(upload ? { quarantine_playback_key: null, quarantine_thumbnail_key: null } : {}) } : {}),
      })
      .where('id', '=', video.id).where('status', '=', opts.expectStatus).where('deleted_at', 'is', null)
      .returning('id').executeTakeFirst();
    if (!row) throw new RollbackSignal();

    if (deep && !d.childSafety) {
      const best = new Map<string, number>();
      for (const s of deep.skills) if (s.confidence >= MIN_TAG_CONFIDENCE) best.set(s.key, Math.max(best.get(s.key) ?? 0, s.confidence));
      // A rerun replaces the earlier AI suggestions; the player's own tags (source 'user') are never touched.
      await tx.deleteFrom('video_skills').where('video_id', '=', video.id).where('source', '=', 'ai').execute();
      if (best.size > 0) {
        const model = scan.modelVersion?.split(';').find((m) => m.startsWith('deep:'))?.slice(5) ?? null;
        await tx.insertInto('video_skills')
          .values([...best].map(([key, confidence]) => ({ video_id: video.id, skill_key: key, source: 'ai', confidence: Math.round(confidence * 1000) / 1000, model })))
          .execute();
      }
    }

    const caseId = needsCase(d, opts.kind) || (!upload && wasPublic && d.decision !== 'APPROVED')
      ? await routeToReview(tx, { videoId: video.id, ownerId: video.owner_user_id, decision: d, resultId })
      : null;

    if (d.childSafety) await holdUploadsForInvestigation(tx, video.owner_user_id, now);
    else if (d.decision === 'REJECTED') {
      const categories = d.categories.length ? d.categories : d.reasonCodes.includes('STATIC_IMAGE') ? ['not_football'] : [];
      await applyStrike(tx, { userId: video.owner_user_id, videoId: video.id, caseId, categories, source: 'auto', now });
    }

    await auditEntry(tx, {
      actorId: null, action: 'guardian.decision', videoId: video.id, caseId,
      metadata: { scanKind: opts.kind, decision: d.decision, reasonCodes: d.reasonCodes, priority: d.priority, model: scan.modelVersion, policy: service.policy.version, resultId },
    });

    if (next.outcome !== 'unchanged') {
      const message = wasPublic && d.decision === 'REJECTED' ? USER_MESSAGES.removed : userMessage(d);
      const kind = next.outcome === 'published' ? 'video.published' : next.outcome === 'removed' ? 'video.removed'
        : d.decision === 'REJECTED' && !d.childSafety ? 'video.rejected' : 'video.review_required';
      await notify(tx, video.owner_user_id, kind, { videoId: video.id, ...(message ? { reason: message } : {}) });
    }
    return true;
  }).catch((err) => {
    if (err instanceof RollbackSignal) return false;
    throw err;
  });

  if (!applied) {
    if (publish) await deps.storage.deleteObjects('delivery', [playbackKey(video.id), thumbnailKey(video.id)]).catch(() => {});
    return { outcome: 'skipped', reason: 'video changed during analysis' };
  }

  await service.storeHashes(video.id, scan.hashes).catch((err: Error) => log.warn('could not store frame hashes', { videoId: video.id, error: err.message }));
  if (wasPublic && next.status !== 'published') await unpublishVideo(deps, video.id);
  if (next.outcome === 'published') {
    // Saved-search alerts for scouts. Best effort: the next maintenance run catches up on a failure.
    await runSavedSearchAlerts(db, { videoIds: [video.id] }).catch((err: Error) => log.warn('saved-search alerts failed', { videoId: video.id, error: err.message }));
    await recordServerEvent(db, 'upload_published', { videoId: video.id }, { userId: video.owner_user_id })
      .catch((err: Error) => log.warn('analytics event failed', { videoId: video.id, error: err.message }));
  }
  return { outcome: next.outcome };
}

class RollbackSignal extends Error {}

// ---------------------------------------------------------------- re-scans

/**
 * Re-checks a video already through the pipeline: after user reports, after a policy or model update,
 * or when a reviewer asks for it. Uses the private processed copy (or the public one for a video
 * published before Guardian). A published video that no longer passes leaves public view at once.
 */
export async function processRescan(deps: PipelineDeps, videoId: string, kind: Exclude<ScanKind, 'upload'>): Promise<ProcessResult> {
  const { db } = deps;
  const video = await loadVideo(db, videoId);
  if (!video || video.status === 'deleted' || video.deleted_at) return { outcome: 'skipped', reason: 'video not found or deleted' };
  if (video.legal_hold) return { outcome: 'skipped', reason: 'video is under legal hold' };
  if (!['published', 'review_required', 'rejected'].includes(video.status)) return { outcome: 'skipped', reason: `video is ${video.status}` };
  const source = video.quarantine_playback_key ? { area: 'originals' as const, key: video.quarantine_playback_key }
    : video.playback_key && !isUrl(video.playback_key) ? { area: 'delivery' as const, key: video.playback_key } : null;
  if (!source) return { outcome: 'skipped', reason: 'no stored copy to scan' };
  const service = guardian(deps);

  const dir = await mkdtemp(path.join(deps.workDir ?? os.tmpdir(), `rescan-${videoId}-`));
  try {
    const file = path.join(dir, 'playback.mp4');
    await deps.storage.downloadObject(source.area, source.key, file, deps.maxOriginalBytes);
    const info = await probe(deps.media, file);
    const scan = await service.scan({
      videoId, ownerId: video.owner_user_id, ownerIsMinor: await ownerIsMinor(db, video.owner_user_id), path: file, workDir: dir,
      durationMs: info.durationMs ?? video.duration_ms ?? 0, width: info.width, height: info.height, hasAudio: info.hasAudio,
      sha256: video.sha256 ?? (await sha256File(file)), metadata: await metadataOf(db, video),
    });
    if (kind === 'report') scan.decision.reasonCodes.push('USER_REPORTS');
    if (kind === 'policy_update') scan.decision.reasonCodes.push('POLICY_RESCAN');
    return await applyScan(deps, service, video, scan, { kind, expectStatus: video.status });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- publish and unpublish

/**
 * Publishes a video a reviewer approved: copies the private processed files to public delivery, then
 * marks it published. Only an APPROVED video can be published (the database enforces this too).
 */
export async function publishVideo(deps: PipelineDeps, videoId: string): Promise<ProcessResult> {
  const { db } = deps;
  const video = await loadVideo(db, videoId);
  if (!video || video.status === 'deleted' || video.deleted_at) return { outcome: 'skipped', reason: 'video not found or deleted' };
  if (video.safety_status !== 'APPROVED') return { outcome: 'skipped', reason: `video is ${video.safety_status}` };
  if (video.status === 'published') return { outcome: 'skipped', reason: 'already published' };
  let keys: { playback_key: string; thumbnail_key: string | null } | null = null;
  if (video.quarantine_playback_key) {
    const dir = await mkdtemp(path.join(deps.workDir ?? os.tmpdir(), `publish-${videoId}-`));
    try {
      const pb = path.join(dir, 'playback.mp4');
      await deps.storage.downloadObject('originals', video.quarantine_playback_key, pb, deps.maxOriginalBytes);
      await deps.storage.uploadDelivery(playbackKey(videoId), pb, 'video/mp4');
      let thumb: string | null = null;
      if (video.quarantine_thumbnail_key) {
        const th = path.join(dir, 'thumb.jpg');
        await deps.storage.downloadObject('originals', video.quarantine_thumbnail_key, th, 10 * 1024 * 1024);
        await deps.storage.uploadDelivery(thumbnailKey(videoId), th, 'image/jpeg');
        thumb = thumbnailKey(videoId);
      }
      keys = { playback_key: playbackKey(videoId), thumbnail_key: thumb };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else if (!video.playback_key) {
    return { outcome: 'skipped', reason: 'no processed copy to publish' };
  }
  const row = await db.transaction().execute(async (tx) => {
    const r = await tx.updateTable('videos')
      .set({ status: 'published', status_reason: null, published_at: sql`coalesce(published_at, now())`, ...(keys ?? {}) })
      .where('id', '=', videoId).where('safety_status', '=', 'APPROVED').where('status', '<>', 'deleted').where('deleted_at', 'is', null)
      .returning('id').executeTakeFirst();
    if (r) await notify(tx, video.owner_user_id, 'video.published', { videoId });
    return r;
  });
  if (!row) return { outcome: 'skipped', reason: 'video changed before publishing' };
  await runSavedSearchAlerts(db, { videoIds: [videoId] }).catch((err: Error) => deps.log.warn('saved-search alerts failed', { videoId, error: err.message }));
  await recordServerEvent(db, 'upload_published', { videoId }, { userId: video.owner_user_id }).catch(() => {});
  return { outcome: 'published' };
}

/**
 * Takes a video's public files down once it is no longer published (removed, restricted for
 * investigation, rejected on appeal review). The private copy stays for review and appeals.
 */
export async function unpublishVideo(deps: PipelineDeps, videoId: string): Promise<ProcessResult> {
  const video = await loadVideo(deps.db, videoId);
  if (!video) return { outcome: 'skipped', reason: 'video not found' };
  if (video.status === 'published' && video.safety_status === 'APPROVED') return { outcome: 'skipped', reason: 'video is public' };
  const keys = [video.playback_key, video.thumbnail_key].filter((k): k is string => !!k && !isUrl(k));
  if (keys.length) await deps.storage.deleteObjects('delivery', keys);
  await deps.db.updateTable('videos')
    .set({ playback_key: isUrl(video.playback_key) ? video.playback_key : null, thumbnail_key: isUrl(video.thumbnail_key) ? video.thumbnail_key : null })
    .where('id', '=', videoId).where('status', '<>', 'published').execute();
  return { outcome: 'unchanged' };
}

// ---------------------------------------------------------------- failure

/**
 * Called once a video.process job has run out of attempts (or hit a permanent error). The scan failed:
 * that is never an approval. With a processed copy a person can still review it; without one the
 * player has to upload again.
 */
export async function markVideoFailed(db: Database, videoId: string, error: string, policyVersion = 'unknown') {
  const reason = 'We could not process this video. Please try uploading it again.';
  await db.transaction().execute(async (tx) => {
    const current = await tx.selectFrom('videos').select(['quarantine_playback_key']).where('id', '=', videoId).executeTakeFirst();
    const reviewable = !!current?.quarantine_playback_key;
    const video = await tx.updateTable('videos')
      .set({ status: reviewable ? 'review_required' : 'failed', safety_status: 'SCAN_FAILED', safety_checked_at: sql`now()`, status_reason: reviewable ? USER_MESSAGES.review : reason })
      .where('id', '=', videoId).where('status', 'in', ACTIVE).where('deleted_at', 'is', null)
      .returning(['id', 'owner_user_id']).executeTakeFirst();
    if (!video) return;
    const decision: GuardianDecision = {
      decision: 'SCAN_FAILED', reasonCodes: ['CLASSIFIER_ERROR'], categories: [], categoryProbabilities: {}, footballRelevance: null, confidence: null,
      suspicious: [], childSafety: false, priority: 2, reviewRequired: true, explanation: null,
    };
    const resultId = await insertResult(tx, {
      videoId, scanKind: 'upload', decision, stages: [], framesAnalyzed: 0, modelVersion: null, policyVersion, latencyMs: null,
      retry: { exhausted: true, lastError: error.slice(0, 500) },
    });
    const caseId = reviewable ? await routeToReview(tx, { videoId, ownerId: video.owner_user_id, decision, resultId }) : null;
    await notify(tx, video.owner_user_id, reviewable ? 'video.review_required' : 'video.failed', { videoId, reason: reviewable ? USER_MESSAGES.review : reason });
    await auditEntry(tx, { actorId: null, action: 'video.processing_failed', videoId, caseId, metadata: { error: error.slice(0, 500), safetyStatus: 'SCAN_FAILED' } });
  });
}
