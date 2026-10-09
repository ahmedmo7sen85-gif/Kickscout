/**
 * Leaderboards. An entry is listed only when it is approved, has a confirmed score, and its video is
 * discoverable: published by the safety pipeline, public, from an active public profile. A minor's
 * clip is private until their guardian opens the profile, so it is judged but never listed.
 */
import { sql } from 'kysely';
import type { Rubric, RankableEntry } from '@fp/domain';
import { rankEntries } from '@fp/domain';
import type { Conn } from './agents.js';

export interface LeaderboardRow extends RankableEntry {
  videoId: string;
  handle: string;
  displayName: string;
  avatarKey: string | null;
  verified: boolean;
  isDemo: boolean;
  /** Only when the player chose to show their country. */
  country: string | null;
  thumbnailKey: string | null;
}

export interface RubricRow {
  id: string;
  version: number;
  rubric: Rubric;
  frozen: boolean;
}

export async function currentRubric(db: Conn, challengeId: string): Promise<RubricRow | null> {
  const r = await db.selectFrom('challenges').innerJoin('challenge_rubric_versions as rv', 'rv.id', 'challenges.rubric_version_id')
    .select(['rv.id', 'rv.version', 'rv.rubric', 'rv.frozen_at']).where('challenges.id', '=', challengeId).executeTakeFirst();
  return r ? { id: r.id, version: r.version, rubric: r.rubric as unknown as Rubric, frozen: r.frozen_at !== null } : null;
}

export async function rubricById(db: Conn, id: string): Promise<RubricRow> {
  const r = await db.selectFrom('challenge_rubric_versions').select(['id', 'version', 'rubric', 'frozen_at']).where('id', '=', id).executeTakeFirstOrThrow();
  return { id: r.id, version: r.version, rubric: r.rubric as unknown as Rubric, frozen: r.frozen_at !== null };
}

/** Every listable approved entry of a challenge (all of a player's entries; ranking keeps their best). */
export async function leaderboardRows(db: Conn, challengeId: string, opts: { excludeUsers?: readonly string[] } = {}): Promise<LeaderboardRow[]> {
  let q = db.selectFrom('challenge_submissions as s')
    .innerJoin('challenge_scores as sc', (j) => j.onRef('sc.submission_id', '=', 's.id').on('sc.superseded_at', 'is', null).on('sc.review_status', '=', 'confirmed'))
    .innerJoin('videos as v', 'v.id', 's.video_id')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .innerJoin('profiles as p', 'p.user_id', 's.user_id')
    .innerJoin('privacy_settings as ps', 'ps.user_id', 's.user_id')
    .leftJoin('regions as r', 'r.id', 'p.region_id')
    .select([
      's.id as submissionId', 's.user_id as userId', 's.video_id as videoId', 's.created_at', 'sc.id as scoreId', 'sc.value', 'sc.penalties',
      'p.handle', 'p.display_name', 'p.avatar_key', 'p.verified_at', 'u.is_demo', 'r.country_code', 'ps.show_country', 'ps.region_precision', 'v.thumbnail_key',
    ])
    .where('s.challenge_id', '=', challengeId)
    .where('s.state', '=', 'approved')
    .where('v.status', '=', 'published')
    .where('v.visibility', '=', 'public')
    .where('ps.profile_visibility', '=', 'public')
    .where('u.status', '=', 'active');
  if (opts.excludeUsers?.length) q = q.where('s.user_id', 'not in', opts.excludeUsers);
  const rows = await q.execute();
  if (!rows.length) return [];
  const comps = await db.selectFrom('challenge_score_components').select(['score_id', 'key', 'value']).where('score_id', 'in', rows.map((r) => r.scoreId)).execute();
  const byScore = new Map<string, Record<string, number>>();
  for (const c of comps) byScore.set(c.score_id, { ...(byScore.get(c.score_id) ?? {}), [c.key]: Number(c.value) });
  return rows.map((r) => ({
    submissionId: r.submissionId, userId: r.userId, videoId: r.videoId, value: Number(r.value), penalties: Number(r.penalties),
    components: byScore.get(r.scoreId) ?? {}, submittedAt: r.created_at.toISOString(),
    handle: r.handle, displayName: r.display_name, avatarKey: r.avatar_key, verified: r.verified_at !== null, isDemo: r.is_demo,
    country: r.show_country && r.region_precision !== 'macro' ? r.country_code : null, thumbnailKey: r.thumbnail_key,
  }));
}

/** `overall`, or one country (players who show it). */
export function rankForScope(rubric: Rubric, rows: readonly LeaderboardRow[], scope: string) {
  const inScope = scope === 'overall' ? rows : rows.filter((r) => r.country === scope);
  return rankEntries(rubric, inScope);
}

/** Writes a snapshot per scope (overall plus every country present). Returns the scopes written. */
export async function writeSnapshots(db: Conn, challengeId: string, rubric: RubricRow, kind: 'final' | 'recalculated', computedBy: string | null): Promise<string[]> {
  const rows = await leaderboardRows(db, challengeId);
  const scopes = ['overall', ...new Set(rows.map((r) => r.country).filter((c): c is string => !!c))];
  for (const scope of scopes) {
    const entries = rankForScope(rubric.rubric, rows, scope).map((e) => ({
      rank: e.rank, submissionId: e.submissionId, userId: e.userId, videoId: e.videoId, value: e.value, penalties: e.penalties,
    }));
    await db.insertInto('challenge_leaderboard_snapshots').values({
      challenge_id: challengeId, scope: scope === 'overall' ? 'overall' : `country:${scope}`, kind, rubric_version_id: rubric.id,
      entries: JSON.stringify(entries), computed_by: computedBy,
    }).execute();
  }
  return scopes;
}

/** The newest final (or recalculated) snapshot for a scope, if any. */
export async function latestSnapshot(db: Conn, challengeId: string, scope: string) {
  const key = scope === 'overall' ? 'overall' : `country:${scope}`;
  return db.selectFrom('challenge_leaderboard_snapshots').select(['entries', 'computed_at', 'kind'])
    .where('challenge_id', '=', challengeId).where('scope', '=', key)
    .orderBy('computed_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
}

/** Eligible votes per approved submission. */
export async function eligibleVotes(db: Conn, challengeId: string): Promise<Map<string, number>> {
  const rows = await db.selectFrom('challenge_votes').select(['submission_id', sql<string>`count(*)`.as('n')])
    .where('challenge_id', '=', challengeId).where('eligible', '=', true).groupBy('submission_id').execute();
  return new Map(rows.map((r) => [r.submission_id, Number(r.n)]));
}
