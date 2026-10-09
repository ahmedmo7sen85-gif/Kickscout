/**
 * What happens when an entry is approved (XP, badges, personal bests, the result notice) and when a
 * challenge's results are published (final leaderboards, podium, Community Favorite, Scout Picks,
 * head-to-heads, winner announcements). Both are idempotent: a retry never awards twice.
 */
import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { DB } from '@fp/db';
import { CHALLENGE_XP, IN_FLIGHT_STATES, headToHeadWinner, historyBadges, isBetter, weeklyStreak } from '@fp/domain';
import type { Logger } from '../pipeline.js';
import { recordServerEvent } from '../analytics.js';
import type { Conn } from './agents.js';
import { recordAgentRun, sendChallengeNotice } from './agents.js';
import { currentRubric, eligibleVotes, leaderboardRows, rankForScope, writeSnapshots } from './leaderboard.js';

async function awardBadge(db: Conn, userId: string, badge: string, challengeId: string | null, submissionId: string | null): Promise<boolean> {
  const exists = await db.selectFrom('user_challenge_badges').select('id').where('user_id', '=', userId).where('badge_key', '=', badge)
    .where((eb) => (challengeId ? eb('challenge_id', '=', challengeId) : eb('challenge_id', 'is', null))).executeTakeFirst();
  if (exists) return false;
  await db.insertInto('user_challenge_badges').values({ id: uuidv7(), user_id: userId, badge_key: badge, challenge_id: challengeId, submission_id: submissionId }).execute();
  return true;
}

/** XP once per (player, source, challenge), whatever the day. */
async function awardXp(db: Conn, userId: string, source: 'challenge_entry' | 'challenge_podium' | 'challenge_award', challengeId: string, xp: number) {
  const had = await db.selectFrom('play_xp').select('id').where('user_id', '=', userId).where('source', '=', source).where('ref', '=', challengeId).executeTakeFirst();
  if (had) return;
  await db.insertInto('play_xp').values({ user_id: userId, source, ref: challengeId, xp })
    .onConflict((oc) => oc.columns(['user_id', 'source', 'ref', 'day']).doNothing()).execute();
}

/** Runs in the transaction that approved the entry. */
export async function onSubmissionApproved(tx: Transaction<DB>, submissionId: string): Promise<void> {
  const s = await tx.selectFrom('challenge_submissions as s').innerJoin('challenges as c', 'c.id', 's.challenge_id')
    .innerJoin('challenge_scores as sc', (j) => j.onRef('sc.submission_id', '=', 's.id').on('sc.superseded_at', 'is', null))
    .innerJoin('challenge_rubric_versions as rv', 'rv.id', 's.rubric_version_id')
    .select(['s.id', 's.user_id', 's.challenge_id', 'c.slug', 'c.title', 'c.template_key', 'c.category', 'sc.value', 'rv.rubric'])
    .where('s.id', '=', submissionId).where('s.state', '=', 'approved').executeTakeFirst();
  if (!s) return;
  const challenge = { slug: s.slug, title: s.title };
  const rubric = s.rubric as { direction: 'higher' | 'lower'; unit: string };
  const value = Number(s.value);

  await awardXp(tx, s.user_id, 'challenge_entry', s.challenge_id, CHALLENGE_XP.entry);

  // Personal best: the best earlier approved value in the same challenge type (same template).
  if (s.template_key) {
    const earlier = await tx.selectFrom('challenge_submissions as o').innerJoin('challenges as oc', 'oc.id', 'o.challenge_id')
      .innerJoin('challenge_scores as osc', (j) => j.onRef('osc.submission_id', '=', 'o.id').on('osc.superseded_at', 'is', null))
      .innerJoin('challenge_rubric_versions as orv', 'orv.id', 'o.rubric_version_id')
      .select(['osc.value', sql<string>`orv.rubric->>'unit'`.as('unit')])
      .where('o.user_id', '=', s.user_id).where('o.state', '=', 'approved').where('o.id', '<>', s.id).where('oc.template_key', '=', s.template_key).execute();
    const comparable = earlier.filter((e) => e.unit === rubric.unit).map((e) => Number(e.value));
    if (comparable.length && comparable.every((v) => isBetter(rubric, value, v))) {
      await awardBadge(tx, s.user_id, 'personal_best', s.challenge_id, s.id);
      await sendChallengeNotice(tx, { userId: s.user_id, kind: 'challenge.personal_best', dedupeKey: `pb:${s.id}`, payload: { challengeSlug: s.slug, submissionId: s.id, challenge, value, unit: rubric.unit } });
    }
  }

  const history = await tx.selectFrom('challenge_submissions as o').innerJoin('challenges as oc', 'oc.id', 'o.challenge_id')
    .select(['o.approved_at', 'oc.category']).where('o.user_id', '=', s.user_id).where('o.state', '=', 'approved').execute();
  const badges = historyBadges({
    approved: history.length,
    categories: new Set(history.map((h) => h.category)).size,
    weeklyStreak: weeklyStreak(history.map((h) => h.approved_at ?? new Date()), new Date()),
  });
  for (const b of badges) {
    if (await awardBadge(tx, s.user_id, b, null, s.id)) {
      await sendChallengeNotice(tx, { userId: s.user_id, kind: 'challenge.badge', dedupeKey: `badge:${b}`, payload: { badge: b, challengeSlug: s.slug, challenge } });
    }
  }

  await sendChallengeNotice(tx, { userId: s.user_id, kind: 'challenge.result', dedupeKey: `sub:${s.id}:result:${value}`, payload: { challengeSlug: s.slug, submissionId: s.id, challenge, value, unit: rubric.unit } });
  await recordServerEvent(tx, 'challenge_entry_approved', { challengeId: s.challenge_id, submissionId: s.id }, { userId: s.user_id });
}

export type FinalizeResult =
  | { completed: true; podium: number; scopes: string[]; alreadyCompleted?: boolean }
  | { completed: false; reason: 'not_judging' | 'entries_pending'; pending?: number };

/**
 * Publishes a challenge's results. Only from `judging`, and only when no entry is still on its way
 * (unless `force`, used by an admin who has decided to close judging; those entries stay unranked).
 */
export async function finalizeChallenge(db: Conn, challengeId: string, opts: { actorId: string | null; force?: boolean; log?: Logger | null }): Promise<FinalizeResult> {
  const run = async (tx: Transaction<DB>): Promise<FinalizeResult> => {
    const c = await tx.selectFrom('challenges').select(['id', 'slug', 'title', 'status', 'voting_enabled'])
      .where('id', '=', challengeId).forUpdate().executeTakeFirst();
    if (!c) return { completed: false, reason: 'not_judging' };
    if (c.status === 'completed') return { completed: true, podium: 0, scopes: [], alreadyCompleted: true };
    if (c.status !== 'judging') return { completed: false, reason: 'not_judging' };
    const pending = await tx.selectFrom('challenge_submissions').select((eb) => eb.fn.countAll<string>().as('n'))
      .where('challenge_id', '=', challengeId).where('state', 'in', IN_FLIGHT_STATES).executeTakeFirstOrThrow();
    if (Number(pending.n) > 0 && !opts.force) return { completed: false, reason: 'entries_pending', pending: Number(pending.n) };

    const rubric = (await currentRubric(tx, challengeId))!;
    const challenge = { slug: c.slug, title: c.title };
    const scopes = await writeSnapshots(tx, challengeId, rubric, 'final', opts.actorId);
    const rows = await leaderboardRows(tx, challengeId);
    const ranked = rankForScope(rubric.rubric, rows, 'overall');

    const podium = ranked.filter((e) => e.rank <= 3);
    for (const e of podium) {
      await awardBadge(tx, e.userId, 'podium', challengeId, e.submissionId);
      if (e.rank === 1) await awardBadge(tx, e.userId, 'winner', challengeId, e.submissionId);
      await awardXp(tx, e.userId, 'challenge_podium', challengeId, CHALLENGE_XP.podium[e.rank - 1]!);
    }

    if (c.voting_enabled) {
      const votes = await eligibleVotes(tx, challengeId);
      const fav = rows.map((r) => ({ r, n: votes.get(r.submissionId) ?? 0 })).filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n || a.r.submittedAt.localeCompare(b.r.submittedAt))[0];
      if (fav) {
        await awardBadge(tx, fav.r.userId, 'community_favorite', challengeId, fav.r.submissionId);
        await awardXp(tx, fav.r.userId, 'challenge_award', challengeId, CHALLENGE_XP.award);
      }
    }

    const listable = new Set(rows.map((r) => r.submissionId));
    const picks = await tx.selectFrom('challenge_scout_picks as sp').innerJoin('challenge_submissions as s', 's.id', 'sp.submission_id')
      .select(['s.id', 's.user_id']).where('sp.challenge_id', '=', challengeId).groupBy(['s.id', 's.user_id']).execute();
    for (const p of picks.filter((x) => listable.has(x.id))) {
      await awardBadge(tx, p.user_id, 'scout_pick', challengeId, p.id);
      await awardXp(tx, p.user_id, 'challenge_award', challengeId, CHALLENGE_XP.award);
    }

    // Head-to-heads are decided by each player's best approved value (listed or not: it is between the two of them).
    const best = await tx.selectFrom('challenge_submissions as s')
      .innerJoin('challenge_scores as sc', (j) => j.onRef('sc.submission_id', '=', 's.id').on('sc.superseded_at', 'is', null))
      .select(['s.user_id', 'sc.value']).where('s.challenge_id', '=', challengeId).where('s.state', '=', 'approved').execute();
    const bestOf = (userId: string) => {
      const vals = best.filter((b) => b.user_id === userId).map((b) => Number(b.value));
      if (!vals.length) return null;
      return rubric.rubric.direction === 'higher' ? Math.max(...vals) : Math.min(...vals);
    };
    const h2h = await tx.selectFrom('challenge_head_to_heads').select(['id', 'challenger_id', 'opponent_id', 'status']).where('challenge_id', '=', challengeId).where('status', 'in', ['pending', 'accepted']).execute();
    for (const h of h2h) {
      if (h.status === 'pending') {
        await tx.updateTable('challenge_head_to_heads').set({ status: 'expired' }).where('id', '=', h.id).execute();
        continue;
      }
      const r = headToHeadWinner(rubric.rubric.direction, { userId: h.challenger_id, value: bestOf(h.challenger_id) }, { userId: h.opponent_id, value: bestOf(h.opponent_id) });
      await tx.updateTable('challenge_head_to_heads').set({ status: r.decided ? 'completed' : 'expired', winner_id: r.winner, completed_at: sql`now()` }).where('id', '=', h.id).execute();
      for (const u of [h.challenger_id, h.opponent_id]) {
        await sendChallengeNotice(tx, { userId: u, kind: 'challenge.h2h_result', dedupeKey: `h2h:${h.id}:result`, payload: { challengeSlug: c.slug, challenge, result: r.winner === null ? 'draw' : r.winner === u ? 'won' : 'lost' } });
      }
    }

    await tx.updateTable('challenges').set({ status: 'completed', results_published_at: sql`now()`, updated_at: sql`now()` }).where('id', '=', challengeId).execute();
    await tx.insertInto('audit_logs').values({
      actor_id: opts.actorId, action: 'challenge.results_published', target_kind: 'challenge', target_id: challengeId,
      metadata: JSON.stringify({ podium: podium.map((p) => ({ rank: p.rank, submissionId: p.submissionId })), forced: !!opts.force, pending: Number(pending.n) }),
    }).execute();

    const participants = await tx.selectFrom('challenge_participations').select('user_id').where('challenge_id', '=', challengeId).where('status', '=', 'active').execute();
    for (const p of participants) {
      await sendChallengeNotice(tx, { userId: p.user_id, kind: 'challenge.winners', dedupeKey: `winners:${challengeId}`, payload: { challengeSlug: c.slug, challenge } });
    }
    return { completed: true, podium: podium.length, scopes };
  };
  const started = performance.now();
  const result = db.isTransaction ? await run(db as Transaction<DB>) : await db.transaction().execute(run);
  await recordAgentRun(db, opts.log ?? null, {
    agent: 'operations', outcome: result.completed ? 'ok' : 'skipped', latencyMs: performance.now() - started,
    subjectKind: 'challenge', subjectId: challengeId, detail: { step: 'finalize', ...result },
  });
  return result;
}
