/**
 * Challenge Operations Agent, run by the existing maintenance pass (daily cron and every worker
 * wake): moves challenges along their schedule and freezes rubrics, publishes results once judging
 * is done, re-syncs entries whose sync job was lost, watches the judging backlog, failure and cost
 * spikes, sends ending-soon and new-challenge reminders, and lets the Anti-Fraud Agent set aside
 * coordinated votes. Every step is idempotent and safe to run concurrently with itself.
 */
import { sql } from 'kysely';
import type { Database } from '@fp/db';
import { IN_FLIGHT_STATES, UPLOAD_GRACE_MS, detectVoteBursts, scheduledTransition, stateFromVideo } from '@fp/domain';
import type { ChallengeStatus } from '@fp/domain';
import type { Logger } from '../pipeline.js';
import { runAgent, sendChallengeNotice } from './agents.js';
import { finalizeChallenge } from './results.js';
import { syncSubmissionForVideo } from './sync.js';

export interface ChallengeOpsReport {
  transitioned: number;
  rubricsFrozen: number;
  resultsPublished: number;
  resynced: number;
  stuckProcessing: number;
  judgingBacklog: number;
  remindersSent: number;
  newChallengeNotices: number;
  votesSetAside: number;
  headToHeadsExpired: number;
  alerts: string[];
}

export const STUCK_PROCESSING_HOURS = 6;
export const JUDGING_SLA_HOURS = 72;

export async function runChallengeOperations(db: Database, log: Logger, now: Date = new Date()): Promise<ChallengeOpsReport> {
  const report: ChallengeOpsReport = {
    transitioned: 0, rubricsFrozen: 0, resultsPublished: 0, resynced: 0, stuckProcessing: 0, judgingBacklog: 0,
    remindersSent: 0, newChallengeNotices: 0, votesSetAside: 0, headToHeadsExpired: 0, alerts: [],
  };
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  await runAgent(db, log, 'operations', { kind: 'batch' }, async () => {
    // ---- schedule: scheduled → active → judging, freezing the rubric as the challenge starts
    const due = await db.selectFrom('challenges').select(['id', 'status', 'starts_at', 'ends_at', 'rubric_version_id', 'slug', 'title', 'skill_key', 'category'])
      .where('is_template', '=', false).where('status', 'in', ['scheduled', 'active']).where('starts_at', '<=', now).execute();
    const opened: typeof due = [];
    for (const c of due) {
      const to = scheduledTransition({ status: c.status as ChallengeStatus, startsAt: c.starts_at, endsAt: c.ends_at }, now);
      if (to) {
        const moved = await db.updateTable('challenges').set({ status: to, updated_at: now }).where('id', '=', c.id).where('status', '=', c.status).returning('id').executeTakeFirst();
        if (moved) {
          report.transitioned++;
          await db.insertInto('audit_logs').values({ actor_id: null, action: 'challenge.status_changed', target_kind: 'challenge', target_id: c.id, metadata: JSON.stringify({ from: c.status, to, by: 'operations' }) }).execute();
          if (to === 'active') opened.push(c);
        }
      }
      if (c.rubric_version_id) {
        const frozen = await db.updateTable('challenge_rubric_versions').set({ frozen_at: now }).where('id', '=', c.rubric_version_id).where('frozen_at', 'is', null).executeTakeFirst();
        report.rubricsFrozen += Number(frozen.numUpdatedRows);
      }
    }

    // ---- results: judging challenges past the upload grace with nothing left in flight
    const judging = await db.selectFrom('challenges').select('id').where('status', '=', 'judging').where('ends_at', '<', new Date(now.getTime() - UPLOAD_GRACE_MS)).execute();
    for (const c of judging) {
      const r = await finalizeChallenge(db, c.id, { actorId: null, log });
      if (r.completed && !r.alreadyCompleted) report.resultsPublished++;
    }

    // ---- self-healing: entries whose video moved on without a sync (a lost job)
    const drift = await db.selectFrom('challenge_submissions as s').innerJoin('videos as v', 'v.id', 's.video_id')
      .select(['s.video_id', 's.state', 'v.status']).where('s.state', 'in', IN_FLIGHT_STATES).where('s.updated_at', '<', hoursAgo(0.25)).limit(200).execute();
    for (const d of drift) {
      const target = stateFromVideo(d.status);
      const behind = target === null ? d.state !== 'pending_judging' : target !== d.state;
      if (behind) {
        const r = await syncSubmissionForVideo(db, d.video_id, log).catch((err: Error) => ({ skipped: err.message }));
        if ('to' in r) report.resynced++;
      }
    }

    // ---- watch: processing that never finishes, and the judging backlog
    const stuck = await db.selectFrom('challenge_submissions').select((eb) => eb.fn.countAll<string>().as('n'))
      .where('state', 'in', ['processing', 'pending_moderation']).where('updated_at', '<', hoursAgo(STUCK_PROCESSING_HOURS)).executeTakeFirstOrThrow();
    report.stuckProcessing = Number(stuck.n);
    if (report.stuckProcessing > 0) report.alerts.push(`stuck_processing:${report.stuckProcessing}`);
    const backlog = await db.selectFrom('challenge_submissions').select((eb) => eb.fn.countAll<string>().as('n'))
      .where('state', '=', 'pending_judging').where('updated_at', '<', hoursAgo(JUDGING_SLA_HOURS)).executeTakeFirstOrThrow();
    report.judgingBacklog = Number(backlog.n);
    if (report.judgingBacklog > 0) report.alerts.push(`judging_backlog:${report.judgingBacklog}`);

    // ---- failure spike: more than 20% of the last day's finished entries failed processing
    const day = await db.selectFrom('challenge_submissions').select((eb) => [
      eb.fn.countAll<string>().filterWhere('state', '=', 'failed_processing').as('failed'),
      eb.fn.countAll<string>().filterWhere('state', 'not in', IN_FLIGHT_STATES).as('finished'),
    ]).where('updated_at', '>', hoursAgo(24)).executeTakeFirstOrThrow();
    if (Number(day.failed) >= 5 && Number(day.failed) / Math.max(1, Number(day.finished)) > 0.2) report.alerts.push(`failure_spike:${day.failed}/${day.finished}`);

    // ---- cost spike: agent spend in the last day over three times the daily average of the week before
    const cost = await db.selectFrom('challenge_agent_runs').select([
      sql<string>`coalesce(sum(cost_usd_micros) FILTER (WHERE created_at > ${hoursAgo(24)}), 0)`.as('today'),
      sql<string>`coalesce(sum(cost_usd_micros) FILTER (WHERE created_at <= ${hoursAgo(24)} AND created_at > ${hoursAgo(24 * 8)}), 0)`.as('week'),
    ]).executeTakeFirstOrThrow();
    const today = Number(cost.today);
    const avg = Number(cost.week) / 7;
    if (today > 1_000_000 && today > 3 * avg) report.alerts.push(`cost_spike:${(today / 1e6).toFixed(2)}usd`);

    // ---- head-to-heads still pending when the challenge stopped taking entries
    const expired = await db.updateTable('challenge_head_to_heads').set({ status: 'expired' }).where('status', '=', 'pending')
      .where('challenge_id', 'in', (eb) => eb.selectFrom('challenges').select('id').where('ends_at', '<', now)).executeTakeFirst();
    report.headToHeadsExpired = Number(expired.numUpdatedRows);

    for (const a of report.alerts) log.error('challenge operations alert', { alert: a });
    return { outcome: report.alerts.length ? 'flagged' : 'ok', value: null, detail: { ...report } };
  });

  // ---- Notification Agent: ending soon (joined, nothing entered yet) and new challenges for players who fit
  await runAgent(db, log, 'notification', { kind: 'batch' }, async () => {
    const ending = await db.selectFrom('challenge_participations as p').innerJoin('challenges as c', 'c.id', 'p.challenge_id')
      .select(['p.user_id', 'c.id', 'c.slug', 'c.title', 'c.ends_at'])
      .where('c.status', '=', 'active').where('c.ends_at', '>', now).where('c.ends_at', '<=', new Date(now.getTime() + 24 * 3_600_000))
      .where('p.status', '=', 'active')
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('challenge_submissions as s').select('s.id')
        .whereRef('s.participation_id', '=', 'p.id').where('s.state', 'not in', ['withdrawn', 'failed_processing', 'rejected']))))
      .limit(1000).execute();
    for (const e of ending) {
      const r = await sendChallengeNotice(db, { userId: e.user_id, kind: 'challenge.ending_soon', dedupeKey: `ending:${e.id}`, payload: { challengeSlug: e.slug, challenge: { slug: e.slug, title: e.title }, endsAt: e.ends_at.toISOString() } });
      if (r === 'sent') report.remindersSent++;
    }
    return { outcome: 'ok', value: null, detail: { endingSoon: ending.length, sent: report.remindersSent } };
  });

  // ---- Recommendation + Notification: a newly opened challenge, to players with a recent clip of its skill
  const openedNow = await db.selectFrom('challenges').select(['id', 'slug', 'title', 'skill_key'])
    .where('status', '=', 'active').where('is_template', '=', false).where('visibility', '=', 'public').where('is_demo', '=', false)
    .where('starts_at', '>', hoursAgo(26)).where('starts_at', '<=', now).execute();
  for (const c of openedNow) {
    if (!c.skill_key) continue;
    await runAgent(db, log, 'recommendation', { kind: 'challenge', id: c.id }, async () => {
      const fits = await db.selectFrom('videos').select('owner_user_id').distinct()
        .where('skill_key', '=', c.skill_key).where('status', '=', 'published').where('published_at', '>', hoursAgo(24 * 90))
        .where('owner_user_id', 'not in', (eb) => eb.selectFrom('challenge_participations').select('user_id').where('challenge_id', '=', c.id))
        .limit(200).execute();
      let sent = 0;
      for (const f of fits) {
        if ((await sendChallengeNotice(db, { userId: f.owner_user_id, kind: 'challenge.new_match', dedupeKey: `new:${c.id}`, payload: { challengeSlug: c.slug, challenge: { slug: c.slug, title: c.title } } })) === 'sent') sent++;
      }
      report.newChallengeNotices += sent;
      return { outcome: 'ok', value: null, detail: { candidates: fits.length, sent } };
    });
  }

  // ---- Anti-Fraud: set aside young-account votes inside a coordinated burst
  await runAgent(db, log, 'anti_fraud', { kind: 'batch' }, async () => {
    const recent = await db.selectFrom('challenge_votes as cv').innerJoin('users as u', 'u.id', 'cv.voter_id')
      .select(['cv.submission_id', 'cv.voter_id', 'cv.created_at', 'cv.eligible', 'u.created_at as account_created'])
      .where('cv.created_at', '>', hoursAgo(24)).execute();
    const rows = recent.map((v) => ({ submissionId: v.submission_id, voterId: v.voter_id, createdAt: v.created_at, voterAccountAgeMs: v.created_at.getTime() - v.account_created.getTime(), eligible: v.eligible }));
    const bursts = detectVoteBursts(rows);
    for (const b of bursts) {
      const young = rows.filter((r) => r.submissionId === b.submissionId && r.voterAccountAgeMs < 14 * 86_400_000 && r.eligible).map((r) => r.voterId);
      if (!young.length) continue;
      const res = await db.updateTable('challenge_votes').set({ eligible: false, flag_reason: 'burst' })
        .where('submission_id', '=', b.submissionId).where('voter_id', 'in', young).where('eligible', '=', true).executeTakeFirst();
      report.votesSetAside += Number(res.numUpdatedRows);
    }
    return { outcome: bursts.length ? 'flagged' : 'ok', value: null, detail: { scanned: rows.length, bursts } };
  });

  return report;
}
