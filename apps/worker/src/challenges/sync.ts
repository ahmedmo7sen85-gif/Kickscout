/**
 * Keeps a challenge entry in step with its video. The video's status belongs to the mandatory
 * safety pipeline; a database trigger queues `challenge.sync` whenever it changes. When the video
 * is published, the Verification Agent checks what can be observed and the Skill Scoring Agent
 * routes the entry to judging. Nothing here can publish a video or skip moderation.
 */
import { v7 as uuidv7 } from 'uuid';
import type { SubmissionState } from '@fp/domain';
import { scoringRoute, stateFromVideo, verifySubmission } from '@fp/domain';
import type { Logger } from '../pipeline.js';
import type { Conn } from './agents.js';
import { recordAgentRun, runAgent, sendChallengeNotice } from './agents.js';
import { rubricById } from './leaderboard.js';

export type SyncResult = { submissionId: string; from: SubmissionState; to: SubmissionState } | { skipped: string };

/** States a judge or admin set; only the video leaving `published` can move an entry out of them. */
const SETTLED: readonly SubmissionState[] = ['pending_judging', 'approved', 'disqualified'];

export async function syncSubmissionForVideo(db: Conn, videoId: string, log: Logger | null = null): Promise<SyncResult> {
  const row = await db.selectFrom('challenge_submissions as s')
    .innerJoin('videos as v', 'v.id', 's.video_id')
    .innerJoin('challenges as c', 'c.id', 's.challenge_id')
    .select([
      's.id', 's.state', 's.user_id', 's.challenge_id', 's.rubric_version_id', 's.created_at as submitted_at',
      'v.status as video_status', 'v.status_reason', 'v.duration_ms', 'v.created_at as video_created_at', 'v.sha256', 'v.football_present',
      'c.slug', 'c.title', 'c.starts_at', 'c.ends_at', 'c.min_duration_s', 'c.max_duration_s',
    ])
    .where('s.video_id', '=', videoId).executeTakeFirst();
  if (!row) return { skipped: 'not a challenge video' };
  const from = row.state as SubmissionState;
  if (from === 'withdrawn') return { skipped: 'withdrawn' };
  const challenge = { slug: row.slug, title: row.title };
  const move = async (to: SubmissionState, reason: string | null, extra: { verification?: unknown } = {}) => {
    const done = await db.updateTable('challenge_submissions')
      .set({ state: to, state_reason: reason, ...(extra.verification ? { verification: JSON.stringify(extra.verification) } : {}) })
      .where('id', '=', row.id).where('state', '=', from).returning('id').executeTakeFirst();
    return !!done;
  };

  const target = stateFromVideo(row.video_status);
  if (target !== null) {
    if (target === from) return { skipped: 'already in step' };
    if (!(await move(target, target === 'rejected' || target === 'failed_processing' ? row.status_reason : null))) return { skipped: 'changed concurrently' };
    if (target === 'rejected' || target === 'failed_processing') {
      await sendChallengeNotice(db, {
        userId: row.user_id, kind: target === 'rejected' ? 'challenge.submission_rejected' : 'challenge.submission_failed',
        dedupeKey: `sub:${row.id}:${target}`, payload: { challengeSlug: row.slug, submissionId: row.id, challenge, reason: row.status_reason },
      });
    }
    return { submissionId: row.id, from, to: target };
  }

  // Published by the safety pipeline.
  if (SETTLED.includes(from)) return { skipped: 'already past moderation' };
  const duplicate = row.sha256
    ? await db.selectFrom('challenge_submissions as o').innerJoin('videos as ov', 'ov.id', 'o.video_id').select('o.id')
      .where('ov.sha256', '=', row.sha256).where('o.user_id', '<>', row.user_id).where('o.id', '<>', row.id).executeTakeFirst()
    : undefined;
  const verdict = await runAgent(db, log, 'verification', { kind: 'challenge_submission', id: row.id }, async () => {
    const v = verifySubmission({
      durationMs: row.duration_ms, minDurationS: row.min_duration_s, maxDurationS: row.max_duration_s,
      videoCreatedAt: row.video_created_at, startsAt: row.starts_at, endsAt: row.ends_at,
      duplicateOfOtherEntrant: !!duplicate, footballPresent: row.football_present,
    });
    return { outcome: v.pass ? 'ok' : 'flagged', value: v, detail: { checks: v.checks } };
  });

  await db.insertInto('challenge_submission_reviews').values({
    id: uuidv7(), submission_id: row.id, agent: 'verification', kind: 'verification', decision: verdict.pass ? 'pass' : 'fail',
    evidence: JSON.stringify(verdict.checks), notes: verdict.reason,
  }).execute();

  if (!verdict.pass) {
    if (!(await move('rejected', verdict.reason, { verification: verdict.checks }))) return { skipped: 'changed concurrently' };
    await sendChallengeNotice(db, {
      userId: row.user_id, kind: 'challenge.submission_rejected', dedupeKey: `sub:${row.id}:verification`,
      payload: { challengeSlug: row.slug, submissionId: row.id, challenge, reason: verdict.reason },
    });
    return { submissionId: row.id, from, to: 'rejected' };
  }

  if (!(await move('pending_judging', null, { verification: verdict.checks }))) return { skipped: 'changed concurrently' };
  // Skill Scoring Agent: no validated measurement model exists, so this always routes to people.
  const rubric = await rubricById(db, row.rubric_version_id);
  const route = scoringRoute(rubric.rubric);
  await recordAgentRun(db, log, {
    agent: 'scoring', outcome: route.route === 'human' ? 'routed_to_human' : 'ok', latencyMs: 0,
    subjectKind: 'challenge_submission', subjectId: row.id, detail: route,
  });
  await sendChallengeNotice(db, {
    userId: row.user_id, kind: 'challenge.submission_received', dedupeKey: `sub:${row.id}:received`,
    payload: { challengeSlug: row.slug, submissionId: row.id, challenge },
  });
  return { submissionId: row.id, from, to: 'pending_judging' };
}
