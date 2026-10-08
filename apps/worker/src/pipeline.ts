import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { DB, Database } from '@fp/db';
import type { AnalysisOutcome, VideoAnalyzer } from './analyzer/types.js';
import { decide, MIN_TAG_CONFIDENCE } from './decision.js';
import type { Decision } from './decision.js';
import { MediaRejection } from './errors.js';
import { decodeCheck, extractFrames, probe, sha256File, thumbnail, transcode, validate } from './media.js';
import type { MediaTools, ProbeInfo, TrimWindow } from './media.js';
import { playbackKey, thumbnailKey } from './storage/storage.js';
import type { VideoStorage } from './storage/storage.js';
import { runSavedSearchAlerts } from './alerts.js';

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface PipelineDeps {
  db: Database;
  storage: VideoStorage;
  /** null when no AI is configured: nothing is auto-published. */
  analyzer: VideoAnalyzer | null;
  media: MediaTools;
  maxOriginalBytes: number;
  workDir?: string | undefined;
  log: Logger;
}

export type ProcessResult =
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'rejected'; reason: string }
  | { outcome: Decision['status'] };

/** Statuses in which a video may be (re)processed; anything else means the job already ran or the video moved on. */
const ACTIVE = ['processing', 'analyzing'] as const;

type Db = Kysely<DB> | Transaction<DB>;

async function notify(db: Db, userId: string, kind: string, payload: Record<string, unknown>) {
  await db.insertInto('notifications').values({ id: uuidv7(), user_id: userId, kind, payload: JSON.stringify(payload) }).execute();
}

export async function processVideo(deps: PipelineDeps, videoId: string): Promise<ProcessResult> {
  const { db, log } = deps;
  const video = await db.selectFrom('videos').selectAll().where('id', '=', videoId).executeTakeFirst();
  if (!video) return { outcome: 'skipped', reason: 'video not found' };
  if (video.status === 'deleted' || video.deleted_at) return { outcome: 'skipped', reason: 'video deleted' };
  if (!(ACTIVE as readonly string[]).includes(video.status)) return { outcome: 'skipped', reason: `video is ${video.status}` };

  const dir = await mkdtemp(path.join(deps.workDir ?? os.tmpdir(), `video-${videoId}-`));
  try {
    const original = path.join(dir, 'original');
    await deps.storage.downloadOriginal(video.original_key, original, deps.maxOriginalBytes);
    const sha256 = await sha256File(original);

    // ---- validate the real file
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
        const row = await tx
          .updateTable('videos')
          .set({
            status: 'rejected',
            status_reason: err.reason,
            sha256,
            ...(info ? { detected_format: info.format, width: info.width, height: info.height, duration_ms: info.durationMs } : {}),
          })
          .where('id', '=', videoId)
          .where('status', 'in', ACTIVE)
          .where('deleted_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (row) await notify(tx, video.owner_user_id, 'video.rejected', { videoId, reason: err.reason });
        return !!row;
      });
      log.info('video rejected by validation', { videoId, reason: err.reason });
      return changed ? { outcome: 'rejected', reason: err.reason } : { outcome: 'skipped', reason: 'video changed during validation' };
    }

    // ---- transcode, thumbnail, upload
    const playback = path.join(dir, 'playback.mp4');
    const thumb = path.join(dir, 'thumb.jpg');
    await transcode(deps.media, original, playback, trim);
    const out = await probe(deps.media, playback).catch(() => null);
    const outDurationMs = out?.durationMs ?? trim.durationMs;
    await thumbnail(deps.media, playback, thumb, outDurationMs);
    await deps.storage.uploadDelivery(playbackKey(videoId), playback, 'video/mp4');
    await deps.storage.uploadDelivery(thumbnailKey(videoId), thumb, 'image/jpeg');

    const moved = await db
      .updateTable('videos')
      .set({
        status: 'analyzing',
        detected_format: info.format,
        duration_ms: trim.durationMs,
        width: info.width,
        height: info.height,
        sha256,
        playback_key: playbackKey(videoId),
        thumbnail_key: thumbnailKey(videoId),
      })
      .where('id', '=', videoId)
      .where('status', 'in', ACTIVE)
      .where('deleted_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!moved) return { outcome: 'skipped', reason: 'video changed during processing' };

    // ---- context for the decision
    const duplicate = await db
      .selectFrom('videos')
      .select('id')
      .where('sha256', '=', sha256)
      .where('id', '<>', videoId)
      .where('owner_user_id', '<>', video.owner_user_id)
      .where('status', '<>', 'deleted')
      .where('deleted_at', 'is', null)
      .orderBy('created_at')
      .executeTakeFirst();
    const age = await db.selectFrom('age_records').select('age_band').where('user_id', '=', video.owner_user_id).executeTakeFirst();
    const ownerIsMinor = age?.age_band !== 'adult'; // unknown age is treated as a minor

    // ---- AI analysis
    let outcome: AnalysisOutcome | null = null;
    if (deps.analyzer) {
      const frames = await extractFrames(deps.media, playback, dir, outDurationMs);
      outcome = await deps.analyzer.analyze({
        videoId,
        durationMs: outDurationMs,
        width: out?.width ?? info.width,
        height: out?.height ?? info.height,
        frames: await Promise.all(frames.map(async (f) => ({ data: await readFile(f.path), atMs: f.atMs }))),
      });
    }
    const decision = decide(outcome, { ownerIsMinor, duplicateOfOtherOwner: !!duplicate });

    // ---- record everything at once, only if the video is still where we left it
    const applied = await db.transaction().execute(async (tx) => {
      const analysis = outcome?.kind === 'result' ? outcome.analysis : null;
      const aiSummary =
        outcome === null
          ? { available: false }
          : outcome.kind === 'refusal'
            ? { available: true, refused: true, model: outcome.model, explanation: outcome.explanation, category: outcome.category }
            : { available: true, model: outcome.model, result: outcome.analysis };
      const row = await tx
        .updateTable('videos')
        .set({
          status: decision.status,
          status_reason: decision.reason,
          moderation: decision.moderation,
          football_present: analysis?.footballPresent ?? null,
          players_visible: analysis?.playersVisible ?? null,
          ai_summary: JSON.stringify({ ...aiSummary, duplicateOf: duplicate?.id ?? null }),
          ...(decision.status === 'published' ? { published_at: sql`now()` } : {}),
        })
        .where('id', '=', videoId)
        .where('status', '=', 'analyzing')
        .where('deleted_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!row) return false;

      if (analysis) {
        const best = new Map<string, number>();
        for (const s of analysis.skills) {
          if (s.confidence >= MIN_TAG_CONFIDENCE) best.set(s.key, Math.max(best.get(s.key) ?? 0, s.confidence));
        }
        // A rerun replaces the earlier AI suggestions; the player's own tags (source 'user') are never touched.
        await tx.deleteFrom('video_skills').where('video_id', '=', videoId).where('source', '=', 'ai').execute();
        if (best.size > 0) {
          await tx
            .insertInto('video_skills')
            .values([...best].map(([key, confidence]) => ({ video_id: videoId, skill_key: key, source: 'ai', confidence: Math.round(confidence * 1000) / 1000 })))
            .execute();
        }
      }

      if (decision.case) {
        const verdict = JSON.stringify({ ...aiSummary, decision: decision.status });
        // One open case per video (unique partial index): merge into an existing one rather than fail.
        await sql`
          INSERT INTO moderation_cases (id, target_kind, target_id, source, categories, ai_verdict, priority)
          VALUES (${uuidv7()}, 'video', ${videoId}, 'ai', ${decision.case.categories}, ${verdict}::jsonb, ${decision.case.priority})
          ON CONFLICT (target_kind, target_id) WHERE status = 'open' DO UPDATE SET
            categories = ARRAY(SELECT DISTINCT unnest(moderation_cases.categories || EXCLUDED.categories) ORDER BY 1),
            ai_verdict = EXCLUDED.ai_verdict,
            priority = LEAST(moderation_cases.priority, EXCLUDED.priority)`.execute(tx);
      }

      await tx
        .insertInto('audit_logs')
        .values({
          actor_id: null,
          action: 'ai.moderation',
          target_kind: 'video',
          target_id: videoId,
          metadata: JSON.stringify({
            decision: decision.status,
            verdict: analysis?.moderation.verdict ?? (outcome?.kind === 'refusal' ? 'refused' : 'unavailable'),
            categories: decision.case?.categories ?? analysis?.moderation.categories ?? [],
            priority: decision.case?.priority ?? null,
            model: outcome?.model ?? null,
            duplicateOf: duplicate?.id ?? null,
          }),
        })
        .execute();

      const kind = decision.status === 'published' ? 'video.published' : decision.status === 'rejected' ? 'video.rejected' : 'video.review_required';
      await notify(tx, video.owner_user_id, kind, { videoId, ...(decision.reason ? { reason: decision.reason } : {}) });
      return true;
    });
    if (!applied) return { outcome: 'skipped', reason: 'video changed during analysis' };
    if (decision.status === 'published') {
      // Saved-search alerts for scouts. Best effort: the next maintenance run catches up on a failure.
      await runSavedSearchAlerts(db, { videoIds: [videoId] }).catch((err: Error) => log.warn('saved-search alerts failed', { videoId, error: err.message }));
    }
    log.info('video processed', { videoId, status: decision.status, categories: decision.case?.categories });
    return { outcome: decision.status };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Called once a video.process job has run out of attempts (or hit a permanent error). */
export async function markVideoFailed(db: Database, videoId: string, error: string) {
  const reason = 'We could not process this video. Please try uploading it again.';
  await db.transaction().execute(async (tx) => {
    const video = await tx
      .updateTable('videos')
      .set({ status: 'failed', status_reason: reason })
      .where('id', '=', videoId)
      .where('status', 'in', ACTIVE)
      .where('deleted_at', 'is', null)
      .returning(['id', 'owner_user_id'])
      .executeTakeFirst();
    if (!video) return;
    await notify(tx, video.owner_user_id, 'video.failed', { videoId, reason });
    await tx
      .insertInto('audit_logs')
      .values({ actor_id: null, action: 'video.processing_failed', target_kind: 'video', target_id: videoId, metadata: JSON.stringify({ error: error.slice(0, 500) }) })
      .execute();
  });
}
