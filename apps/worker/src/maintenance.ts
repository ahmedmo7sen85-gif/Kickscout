import { sql } from 'kysely';
import type { Database } from '@fp/db';
import type { Logger } from './pipeline.js';
import type { VideoStorage } from './storage/storage.js';
import { playbackKey, thumbnailKey } from './storage/storage.js';
import { runSavedSearchAlerts } from './alerts.js';
import { rollupAnalytics } from './analytics.js';
import { runChallengeOperations } from './challenges/operations.js';
import type { ChallengeOpsReport } from './challenges/operations.js';

export interface MaintenanceOptions {
  /** Days a published video's original is kept after publishing (for re-processing), before it is removed. */
  originalRetentionDays: number;
  /** Uploads never completed within this many hours are marked failed. */
  abandonedUploadHours: number;
  /** Most videos cleaned per run, so one run stays well inside a function's time limit. */
  batchSize: number;
}

export const DEFAULT_MAINTENANCE: MaintenanceOptions = { originalRetentionDays: 7, abandonedUploadHours: 24, batchSize: 100 };

export interface MaintenanceReport {
  abandonedUploads: number;
  originalsPurged: number;
  deliveryPurged: number;
  rateLimitRowsPruned: number;
  /** Saved-search alert notifications sent by this run (catch-up for anything the publish-time call missed). */
  alertNotifications: number;
  /** Days rolled up into analytics_daily (with the North Star) by this run; 0 once today's rollup is done. */
  analyticsDaysRolled: number;
  /** Raw analytics events deleted after their 180-day retention (their days are rolled up first). */
  analyticsEventsDeleted: number;
  /** The Challenge Operations Agent's run (null when it failed; see `errors`). */
  challenges: ChallengeOpsReport | null;
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
    abandonedUploads: 0, originalsPurged: 0, deliveryPurged: 0, rateLimitRowsPruned: 0, alertNotifications: 0, analyticsDaysRolled: 0, analyticsEventsDeleted: 0, challenges: null, errors: 0,
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
  const settledOriginals = await db
    .selectFrom('videos')
    .select(['id', 'original_key'])
    .where('original_purged_at', 'is', null)
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

  // Delivery files are public by URL, so a deleted video's playback and thumbnail go on the next run.
  const deleted = await db
    .selectFrom('videos')
    .select(['id', 'playback_key', 'thumbnail_key'])
    .where('status', '=', 'deleted')
    .where('delivery_purged_at', 'is', null)
    .orderBy('deleted_at')
    .limit(opts.batchSize)
    .execute();
  for (const v of deleted) {
    try {
      const keys = [v.playback_key ?? playbackKey(v.id), v.thumbnail_key ?? thumbnailKey(v.id)].filter((k) => !/^https?:\/\//.test(k));
      await storage.deleteObjects('delivery', keys);
      await db.updateTable('videos').set({ delivery_purged_at: now }).where('id', '=', v.id).execute();
      report.deliveryPurged++;
    } catch (err) {
      report.errors++;
      log.warn('could not remove delivery files', { videoId: v.id, error: (err as Error).message });
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

  try {
    report.challenges = await runChallengeOperations(db, log, now);
  } catch (err) {
    report.errors++;
    log.warn('challenge operations failed', { error: (err as Error).message });
  }

  log.info('maintenance finished', { ...report });
  return report;
}
