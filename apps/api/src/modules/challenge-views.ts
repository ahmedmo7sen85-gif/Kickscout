/**
 * Loading and shaping challenges, entries and scores for the API. Visibility rules live here:
 * drafts, templates and archives are staff-only, and nothing about an entry is public before its
 * video is published by the safety pipeline and a judge approved it.
 */
import { sql } from 'kysely';
import type { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { ChallengeView, LeaderboardEntry, MySubmissionView, PublicRubric, ScoreView } from '@fp/contracts';
import type { Database } from '@fp/db';
import type { ChallengeStatus, Rubric, SubmissionState } from '@fp/domain';
import { challengePhase, countsAsAttempt, isPubliclyVisible } from '@fp/domain';
import { latestSnapshot, leaderboardRows, rankForScope } from '@fp/worker/challenges';
import type { LeaderboardRow } from '@fp/worker/challenges';
import type { Deps } from '../deps.js';
import { notFound } from '../platform/errors.js';
import { mediaUrl } from '../platform/storage.js';

type Bi = { en: string; ar: string };

/** Every column a challenge view needs, plus participant and approved-entry counts. */
export function challengeQuery(db: Database) {
  return db.selectFrom('challenges').select((eb) => [
    'challenges.id', 'challenges.slug', 'challenges.title', 'challenges.description', 'challenges.skill_key', 'challenges.hashtag',
    'challenges.starts_at', 'challenges.ends_at', 'challenges.is_demo', 'challenges.status', 'challenges.is_template', 'challenges.template_key',
    'challenges.format', 'challenges.category', 'challenges.difficulty', 'challenges.age_groups', 'challenges.instructions', 'challenges.equipment',
    'challenges.safety_notes', 'challenges.recording', 'challenges.min_duration_s', 'challenges.max_duration_s', 'challenges.timezone',
    'challenges.attempt_limit', 'challenges.retry_failed', 'challenges.requires_partner', 'challenges.visibility', 'challenges.featured',
    'challenges.voting_enabled', 'challenges.reward', 'challenges.thumbnail_key', 'challenges.demo_video_id', 'challenges.results_published_at',
    'challenges.rubric_version_id', 'challenges.updated_at', 'challenges.created_at',
    eb.selectFrom('challenge_participations').select(eb.fn.countAll<string>().as('n')).whereRef('challenge_participations.challenge_id', '=', 'challenges.id').as('participants'),
    eb.selectFrom('challenge_submissions').innerJoin('videos', 'videos.id', 'challenge_submissions.video_id')
      .select(eb.fn.countAll<string>().as('n')).whereRef('challenge_submissions.challenge_id', '=', 'challenges.id')
      .where('challenge_submissions.state', '=', 'approved').where('videos.status', '=', 'published').where('videos.visibility', '=', 'public').as('entries'),
  ]);
}
export type ChallengeRow = Awaited<ReturnType<ReturnType<typeof challengeQuery>['executeTakeFirstOrThrow']>>;

export function phaseOf(r: Pick<ChallengeRow, 'status' | 'starts_at' | 'ends_at'>, now: Date) {
  return challengePhase({ status: r.status as ChallengeStatus, startsAt: r.starts_at, endsAt: r.ends_at }, now);
}

export function toChallengeView(deps: Deps, r: ChallengeRow): z.input<typeof ChallengeView> {
  const now = deps.now();
  const phase = phaseOf(r, now);
  return {
    id: r.id, slug: r.slug, title: r.title as Bi, description: r.description as Bi, skill: r.skill_key as never, hashtag: r.hashtag,
    startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString(),
    state: phase === 'open' ? 'active' : phase === 'upcoming' || phase === 'draft' ? 'upcoming' : 'ended',
    phase, format: r.format as never, category: r.category as never, difficulty: r.difficulty as never, ageGroups: r.age_groups as never,
    featured: r.featured, reward: (r.reward as Bi | null) ?? null, thumbnailUrl: r.thumbnail_key ? mediaUrl(deps.config.CDN_BASE_URL, r.thumbnail_key) : null,
    timezone: r.timezone, participants: Number(r.participants ?? 0), entries: Number(r.entries ?? 0), votingEnabled: r.voting_enabled, isDemo: r.is_demo,
  };
}

/** Challenges anyone may list: published (not draft/archived), not a template, not unlisted. */
export function listable(q: ReturnType<typeof challengeQuery>) {
  return q.where('challenges.is_template', '=', false).where('challenges.status', 'not in', ['draft', 'archived', 'cancelled']).where('challenges.visibility', '=', 'public');
}

export async function challengeViews(deps: Deps, filter: (q: ReturnType<typeof challengeQuery>) => ReturnType<typeof challengeQuery>) {
  return (await filter(challengeQuery(deps.db)).execute()).map((r) => toChallengeView(deps, r));
}

/** A challenge by slug (or id). Hidden ones look missing unless `staff`. */
export async function loadChallenge(deps: Deps, slugOrId: string, opts: { staff?: boolean } = {}): Promise<ChallengeRow> {
  const isId = /^[0-9a-f-]{36}$/i.test(slugOrId);
  const row = await challengeQuery(deps.db).where(isId ? 'challenges.id' : 'challenges.slug', '=', slugOrId).executeTakeFirst();
  if (!row) throw notFound('challenge');
  if (!opts.staff && !isPubliclyVisible({ status: row.status as ChallengeStatus, isTemplate: row.is_template })) throw notFound('challenge');
  return row;
}

export interface RubricRecord { id: string; version: number; rubric: Rubric; frozen: boolean }

export async function rubricRecord(db: Database, id: string | null): Promise<RubricRecord | null> {
  if (!id) return null;
  const r = await db.selectFrom('challenge_rubric_versions').select(['id', 'version', 'rubric', 'frozen_at']).where('id', '=', id).executeTakeFirst();
  return r ? { id: r.id, version: r.version, rubric: r.rubric as unknown as Rubric, frozen: r.frozen_at !== null } : null;
}

export function publicRubric(r: RubricRecord): z.input<typeof PublicRubric> {
  const { aiCapability: _a, ...rest } = r.rubric;
  return { ...rest, attempts: rest.attempts ?? null, version: r.version, frozen: r.frozen };
}

// ---------------------------------------------------------------- entries

export function submissionQuery(db: Database) {
  return db.selectFrom('challenge_submissions as s')
    .innerJoin('challenges as c', 'c.id', 's.challenge_id')
    .innerJoin('videos as v', 'v.id', 's.video_id')
    .innerJoin('challenge_rubric_versions as rv', 'rv.id', 's.rubric_version_id')
    .leftJoin('challenge_scores as sc', (j) => j.onRef('sc.submission_id', '=', 's.id').on('sc.superseded_at', 'is', null))
    .leftJoin('challenge_appeals as ap', (j) => j.onRef('ap.submission_id', '=', 's.id')
      .on('ap.id', '=', (eb) => eb.selectFrom('challenge_appeals as a2').select('a2.id').whereRef('a2.submission_id', '=', 's.id').orderBy('a2.created_at', 'desc').limit(1)))
    .select([
      's.id', 's.challenge_id', 's.user_id', 's.video_id', 's.attempt_no', 's.state', 's.state_reason', 's.claimed_value', 's.created_at', 's.updated_at',
      's.judging_round', 's.verification', 's.participation_id',
      'c.slug', 'c.title', 'c.status as challenge_status', 'c.results_published_at',
      'v.thumbnail_key', 'v.status as video_status', 'v.playback_key', 'v.duration_ms', 'v.visibility as video_visibility',
      'rv.version as rubric_version', 'rv.rubric', 'rv.frozen_at',
      'sc.id as score_id', 'sc.value as score_value', 'sc.penalties as score_penalties', 'sc.method as score_method', 'sc.review_status',
      'ap.id as appeal_id', 'ap.reason as appeal_reason', 'ap.status as appeal_status', 'ap.resolution as appeal_resolution',
      'ap.created_at as appeal_created_at', 'ap.resolved_at as appeal_resolved_at',
    ]);
}
export type SubmissionRow = Awaited<ReturnType<ReturnType<typeof submissionQuery>['executeTakeFirstOrThrow']>>;

/** Days after a decision during which the player may appeal it. */
export const APPEAL_WINDOW_DAYS = 14;

export async function scoreViews(db: Database, rows: readonly SubmissionRow[]): Promise<Map<string, z.input<typeof ScoreView>>> {
  const scored = rows.filter((r) => r.score_id);
  const comps = scored.length
    ? await db.selectFrom('challenge_score_components').select(['score_id', 'key', 'value']).where('score_id', 'in', scored.map((r) => r.score_id!)).execute()
    : [];
  const out = new Map<string, z.input<typeof ScoreView>>();
  for (const r of scored) {
    const rubric = r.rubric as unknown as Rubric;
    out.set(r.id, {
      value: Number(r.score_value), unit: rubric.unit, direction: rubric.direction, penalties: Number(r.score_penalties), method: r.score_method as never,
      reviewStatus: r.review_status as never, rubricVersion: r.rubric_version,
      components: comps.filter((c) => c.score_id === r.score_id).map((c) => ({
        key: c.key, value: Number(c.value), label: rubric.components.find((x) => x.key === c.key)?.label ?? { en: c.key, ar: c.key },
      })),
    });
  }
  return out;
}

/** Whether the player may appeal: a judge's decision (score or disqualification) or a verification rejection, recently. */
export function appealable(r: SubmissionRow, now: Date): boolean {
  if (r.appeal_status === 'open' || r.challenge_status === 'archived') return false;
  const verificationReject = r.state === 'rejected' && r.video_status === 'published';
  if (!(r.state === 'approved' || r.state === 'disqualified' || verificationReject)) return false;
  return now.getTime() - r.updated_at.getTime() < APPEAL_WINDOW_DAYS * 86_400_000;
}

export async function mySubmissionViews(deps: Deps, rows: readonly SubmissionRow[], ranks: Map<string, number> = new Map()): Promise<z.input<typeof MySubmissionView>[]> {
  const scores = await scoreViews(deps.db, rows);
  const now = deps.now();
  return rows.map((r) => ({
    id: r.id, challenge: { id: r.challenge_id, slug: r.slug, title: r.title as Bi }, videoId: r.video_id,
    thumbnailUrl: r.thumbnail_key ? mediaUrl(deps.config.CDN_BASE_URL, r.thumbnail_key) : null,
    attemptNo: r.attempt_no, state: r.state as never, stateReason: r.state_reason, claimedValue: r.claimed_value === null ? null : Number(r.claimed_value),
    score: scores.get(r.id) ?? null, rank: ranks.get(r.id) ?? null,
    appeal: r.appeal_id ? {
      id: r.appeal_id, submissionId: r.id, challenge: { id: r.challenge_id, slug: r.slug, title: r.title as Bi }, reason: r.appeal_reason!,
      status: r.appeal_status as never, resolution: r.appeal_resolution, createdAt: r.appeal_created_at!.toISOString(), resolvedAt: r.appeal_resolved_at?.toISOString() ?? null,
    } : null,
    canAppeal: appealable(r, now),
    canWithdraw: !['withdrawn', 'disqualified'].includes(r.state) && r.results_published_at === null,
    createdAt: r.created_at.toISOString(),
  }));
}

/** Attempts a player has used in a challenge under its retry rule. */
export async function attemptsUsed(db: Database, participationId: string, retryFailed: boolean): Promise<number> {
  const rows = await db.selectFrom('challenge_submissions').select('state').where('participation_id', '=', participationId).execute();
  return rows.filter((r) => countsAsAttempt(r.state as SubmissionState, retryFailed)).length;
}

/** Lowercase, deduplicated hashtags for a challenge entry: the player's own plus the challenge's. */
export function entryHashtags(own: readonly string[], challengeTag: string | null): string[] {
  return [...new Set([...own, ...(challengeTag ? [challengeTag.toLowerCase()] : [])])].slice(0, 10);
}

export const isStaff = (roles: readonly string[]) => roles.includes('admin') || roles.includes('moderator');

/** The approved, scored best value per user in a challenge (for head-to-heads and "my best"). */
export async function bestValues(db: Database, challengeId: string, userIds: readonly string[]) {
  if (!userIds.length) return new Map<string, number>();
  const rows = await db.selectFrom('challenge_submissions as s')
    .innerJoin('challenge_scores as sc', (j) => j.onRef('sc.submission_id', '=', 's.id').on('sc.superseded_at', 'is', null))
    .innerJoin('challenge_rubric_versions as rv', 'rv.id', 's.rubric_version_id')
    .select(['s.user_id', sql<string>`CASE WHEN rv.rubric->>'direction' = 'lower' THEN min(sc.value) ELSE max(sc.value) END`.as('best')])
    .where('s.challenge_id', '=', challengeId).where('s.state', '=', 'approved').where('s.user_id', 'in', userIds)
    .groupBy(['s.user_id', sql`rv.rubric->>'direction'`]).execute();
  return new Map(rows.map((r) => [r.user_id, Number(r.best)]));
}

// ---------------------------------------------------------------- leaderboards

/** The worker's agent helpers log as (message, fields); Fastify logs as (fields, message). */
export function agentLog(log: FastifyBaseLogger) {
  return {
    info: (msg: string, fields?: Record<string, unknown>) => log.info(fields ?? {}, msg),
    warn: (msg: string, fields?: Record<string, unknown>) => log.warn(fields ?? {}, msg),
    error: (msg: string, fields?: Record<string, unknown>) => log.error(fields ?? {}, msg),
  };
}

/** Everyone the viewer blocked or was blocked by (left out of what they see). */
export async function blockedUsers(db: Database, viewerId: string | null): Promise<string[]> {
  if (!viewerId) return [];
  const rows = await db.selectFrom('blocks').select(['blocker_id', 'blocked_id'])
    .where((eb) => eb.or([eb('blocker_id', '=', viewerId), eb('blocked_id', '=', viewerId)])).execute();
  return rows.map((r) => (r.blocker_id === viewerId ? r.blocked_id : r.blocker_id));
}

export function toLeaderboardEntry(deps: Deps, r: LeaderboardRow, rank: number): z.input<typeof LeaderboardEntry> {
  return {
    rank, submissionId: r.submissionId, videoId: r.videoId, value: r.value, penalties: r.penalties, country: r.country,
    thumbnailUrl: r.thumbnailKey ? mediaUrl(deps.config.CDN_BASE_URL, r.thumbnailKey) : null,
    player: {
      userId: r.userId, handle: r.handle, displayName: r.displayName, verified: r.verified, isDemo: r.isDemo,
      avatarUrl: r.avatarKey ? mediaUrl(deps.config.CDN_BASE_URL, r.avatarKey) : null,
    },
  };
}

export interface RankedBoard {
  kind: 'live' | 'final';
  computedAt: Date;
  entries: { row: LeaderboardRow; rank: number }[];
}

/**
 * The leaderboard for a scope. Once results are published it is the final snapshot (re-filtered,
 * so a player who has since gone private, been blocked or left drops out); before that it is live.
 */
export async function rankedBoard(db: Database, challengeId: string, rubric: Rubric, scope: string, opts: { final: boolean; exclude: readonly string[] }): Promise<RankedBoard> {
  const rows = await leaderboardRows(db, challengeId, { excludeUsers: opts.exclude });
  if (opts.final) {
    const snap = await latestSnapshot(db, challengeId, scope);
    if (snap) {
      const bySub = new Map(rows.map((r) => [r.submissionId, r]));
      const entries = (snap.entries as unknown as { rank: number; submissionId: string }[])
        .flatMap((e) => (bySub.has(e.submissionId) ? [{ row: bySub.get(e.submissionId)!, rank: e.rank }] : []));
      return { kind: 'final', computedAt: snap.computed_at, entries };
    }
  }
  return { kind: 'live', computedAt: new Date(), entries: rankForScope(rubric, rows, scope).map((e) => ({ row: e, rank: e.rank })) };
}
