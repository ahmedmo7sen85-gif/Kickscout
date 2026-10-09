import { sql } from 'kysely';
import type { Database } from '@fp/db';
import type { Logger } from './pipeline.js';
import type { VideoStorage } from './storage/storage.js';
import { playbackKey, thumbnailKey } from './storage/storage.js';
import { runSavedSearchAlerts } from './alerts.js';
import { rollupAnalytics } from './analytics.js';

export interface MaintenanceOptions {
  /** Days a published video's original is kept after publishing (for re-processing), before it is removed. */
  originalRetentionDays: number;
  /** Uploads never completed within this many hours are marked failed. */
  abandonedUploadHours: number;
  /** Most videos cleaned per run, so one run stays well inside a function's time limit. */
  batchSize: number;
  /** Days the private copy of a rejected or removed video is kept for review and appeals (never under legal hold). */
  quarantineRetentionDays: number;
}

export const DEFAULT_MAINTENANCE: MaintenanceOptions = { originalRetentionDays: 7, abandonedUploadHours: 24, batchSize: 100, quarantineRetentionDays: 90 };

export interface MaintenanceReport {
  abandonedUploads: number;
  originalsPurged: number;
  deliveryPurged: number;
  /** Public files of videos that are no longer published (a safety net behind the unpublish job). */
  unpublishedSwept: number;
  /** Private copies of rejected or removed videos past their retention. */
  quarantinePurged: number;
  rateLimitRowsPruned: number;
  /** Saved-search alert notifications sent by this run (catch-up for anything the publish-time call missed). */
  alertNotifications: number;
  /** Days rolled up into analytics_daily (with the North Star) by this run; 0 once today's rollup is done. */
  analyticsDaysRolled: number;
  /** Raw analytics events deleted after their 180-day retention (their days are rolled up first). */
  analyticsEventsDeleted: number;
  errors: number;
}

/**
 * Keeps storage and bookkeeping bounded: fails uploads that never finished, removes originals once a video is
 * settled, removes every file of a deleted video, and drops expired rate-limit counters. Safe to run concurrently
 * with itself (each step is idempotent) and in any order with the job worker.
 */
export async function runMaintenance(
  db: Database,
  storage: VideoStorage,
  log: Logger,
  now: Date = new Date(),
  opts: MaintenanceOptions = DEFAULT_MAINTENANCE,
): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    abandonedUploads: 0, originalsPurged: 0, deliveryPurged: 0, unpublishedSwept: 0, quarantinePurged: 0, rateLimitRowsPruned: 0, alertNotifications: 0, analyticsDaysRolled: 0, analyticsEventsDeleted: 0, errors: 0,
  };
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  const abandoned = await db
    .updateTable('videos')
    .set({ status: 'failed', status_reason: 'The upload did not finish. Please upload the video again.' })
    .where('status', '=', 'uploading')
    .where('created_at', '<', hoursAgo(opts.abandonedUploadHours))
    .executeTakeFirst();
  report.abandonedUploads = Number(abandoned.numUpdatedRows);

  // Originals: deleted, rejected and failed videos need none; published ones keep theirs for a while.
  // Evidence under legal hold (suspected child sexual abuse material) is never purged here.
  const settledOriginals = await db
    .selectFrom('videos')
    .select(['id', 'original_key'])
    .where('original_purged_at', 'is', null)
    .where('legal_hold', '=', false)
    .where((eb) =>
      eb.or([
        eb('status', 'in', ['deleted', 'rejected', 'failed']),
        eb.and([eb('status', '=', 'published'), eb('published_at', '<', hoursAgo(opts.originalRetentionDays * 24))]),
      ]),
    )
    .orderBy('created_at')
    .limit(opts.batchSize)
    .execute();
  for (const v of settledOriginals) {
    try {
      await storage.deleteObjects('originals', [v.original_key]);
      await db.updateTable('videos').set({ original_purged_at: now }).where('id', '=', v.id).execute();
      report.originalsPurged++;
    } catch (err) {
      report.errors++;
      log.warn('could not remove original', { videoId: v.id, error: (err as Error).message });
    }
  }

  // Delivery files are public by URL, so a deleted video's playback and thumbnail go on the next run,
  // with its private copies (unless under legal hold).
  const deleted = await db
    .selectFrom('videos')
    .select(['id', 'playback_key', 'thumbnail_key', 'quarantine_playback_key', 'quarantine_thumbnail_key', 'legal_hold'])
    .where('status', '=', 'deleted')
    .where('delivery_purged_at', 'is', null)
    .orderBy('deleted_at')
    .limit(opts.batchSize)
    .execute();
  for (const v of deleted) {
    try {
      const keys = [v.playback_key ?? playbackKey(v.id), v.thumbnail_key ?? thumbnailKey(v.id)].filter((k) => !/^https?:\/\//.test(k));
      await storage.deleteObjects('delivery', keys);
      const quarantined = v.legal_hold ? [] : [v.quarantine_playback_key, v.quarantine_thumbnail_key].filter((k): k is string => !!k);
      if (quarantined.length) await storage.deleteObjects('originals', quarantined);
      await db.updateTable('videos')
        .set({ delivery_purged_at: now, ...(quarantined.length ? { quarantine_playback_key: null, quarantine_thumbnail_key: null } : {}) })
        .where('id', '=', v.id).execute();
      // Frame hashes are kept only for videos removed for their content (to catch re-uploads).
      await db.deleteFrom('video_frame_hashes').where('video_id', '=', v.id)
        .where((eb) => eb.not(eb.exists(eb.selectFrom('videos').select('id').where('id', '=', v.id).where((w) => w.or([w('legal_hold', '=', true), w('moderation', '=', 'rejected')]))))).execute();
      report.deliveryPurged++;
    } catch (err) {
      report.errors++;
      log.warn('could not remove delivery files', { videoId: v.id, error: (err as Error).message });
    }
  }

  // Public files must not outlive publication: sweep any video that left public view but kept them.
  const unpublished = await db
    .selectFrom('videos')
    .select(['id', 'playback_key', 'thumbnail_key'])
    .where('status', 'not in', ['published', 'deleted'])
    .where('playback_key', 'is not', null)
    .where('playback_key', 'not like', 'http%')
    .limit(opts.batchSize)
    .execute();
  for (const v of unpublished) {
    try {
      await storage.deleteObjects('delivery', [v.playback_key, v.thumbnail_key].filter((k): k is string => !!k && !/^https?:\/\//.test(k)));
      await db.updateTable('videos').set({ playback_key: null, thumbnail_key: null }).where('id', '=', v.id).where('status', '<>', 'published').execute();
      report.unpublishedSwept++;
    } catch (err) {
      report.errors++;
      log.warn('could not remove public files of an unpublished video', { videoId: v.id, error: (err as Error).message });
    }
  }

  // Private copies of rejected and removed videos, once the appeal window has passed.
  const expired = await db
    .selectFrom('videos')
    .select(['id', 'quarantine_playback_key', 'quarantine_thumbnail_key'])
    .where('safety_status', 'in', ['REJECTED', 'REMOVED'])
    .where('legal_hold', '=', false)
    .where('quarantine_playback_key', 'is not', null)
    .where('safety_checked_at', '<', hoursAgo(opts.quarantineRetentionDays * 24))
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('moderation_appeals').select('id').whereRef('moderation_appeals.video_id', '=', 'videos.id').where('moderation_appeals.status', '=', 'pending'))))
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('moderation_cases').select('id').whereRef('moderation_cases.target_id', '=', 'videos.id').where('moderation_cases.status', '=', 'open'))))
    .limit(opts.batchSize)
    .execute();
  for (const v of expired) {
    try {
      await storage.deleteObjects('originals', [v.quarantine_playback_key, v.quarantine_thumbnail_key].filter((k): k is string => !!k));
      await db.updateTable('videos').set({ quarantine_playback_key: null, quarantine_thumbnail_key: null }).where('id', '=', v.id).execute();
      report.quarantinePurged++;
    } catch (err) {
      report.errors++;
      log.warn('could not remove quarantined copies', { videoId: v.id, error: (err as Error).message });
    }
  }

  const pruned = await db.deleteFrom('rate_limit_hits').where('reset_at', '<', sql<Date>`${now}::timestamptz - interval '1 hour'`).executeTakeFirst();
  report.rateLimitRowsPruned = Number(pruned.numDeletedRows);

  try {
    report.alertNotifications = (await runSavedSearchAlerts(db, { now })).notifications;
  } catch (err) {
    report.errors++;
    log.warn('saved-search alerts failed', { error: (err as Error).message });
  }

  try {
    const rollup = await rollupAnalytics(db, now);
    report.analyticsDaysRolled = rollup.daysRolled;
    report.analyticsEventsDeleted = rollup.eventsDeleted;
  } catch (err) {
    report.errors++;
    log.warn('analytics rollup failed', { error: (err as Error).message });
  }

  log.info('maintenance finished', { ...report });
  return report;
}
