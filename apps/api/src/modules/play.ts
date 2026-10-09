import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { DB } from '@fp/db';
import type { Database } from '@fp/db';
import {
  CreatePlayChallengeRequest, PlayAnswerRequest, PlayAnswerResponse, PlayChallengeList, PlayChallengeView, PlayDrillRequest,
  PlayFriendList, PlayProfile, PlayRoundView, PlayScanRequest, PlayStartRoundRequest, PlayXpAward,
} from '@fp/contracts';
import {
  answerXp, canChallenge, challengeWinner, drillByKey, levelFor, streakDays, utcDayKey,
  CHALLENGE_DAYS, DAILY_XP_ROUNDS, DAILY_XP_SCAN_RUNS, ROUND_SIZE, XP_CHALLENGE_WIN, XP_PER_SCAN_HIT,
} from '@fp/domain';
import type { AgeBand } from '@fp/domain';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import { ApiError, conflict, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { notify } from '../platform/events.js';
import { blockedEitherWay } from './media.js';
import { bestOption, drawScenarioIds, publicScenario, scenarioById } from './play-scenarios.js';

type Db = Database;
const IdParam = z.uuid();
const dayOf = (d: Date) => sql<Date>`${utcDayKey(d)}::date`;

// ---------------------------------------------------------------- XP profile

export async function playProfile(db: Db, userId: string, now: Date): Promise<z.input<typeof PlayProfile>> {
  const today = utcDayKey(now);
  const [total, days, todayRows, rounds, best] = await Promise.all([
    db.selectFrom('play_xp').select(sql<string>`coalesce(sum(xp), 0)`.as('xp')).where('user_id', '=', userId).executeTakeFirstOrThrow(),
    db.selectFrom('play_xp').select(sql<string>`to_char(day, 'YYYY-MM-DD')`.as('d')).distinct()
      .where('user_id', '=', userId).where('day', '>=', sql<Date>`${today}::date - 400`).execute(),
    db.selectFrom('play_xp').select(['source', 'ref', 'xp']).where('user_id', '=', userId).where('day', '=', sql<Date>`${today}::date`).execute(),
    db.selectFrom('play_rounds').select((eb) => eb.fn.countAll<string>().as('n')).where('user_id', '=', userId).where('completed_at', 'is not', null).executeTakeFirstOrThrow(),
    db.selectFrom('play_answers').innerJoin('play_rounds', 'play_rounds.id', 'play_answers.round_id')
      .select((eb) => eb.fn.countAll<string>().as('n')).where('play_rounds.user_id', '=', userId).where('play_answers.points', '=', 2).executeTakeFirstOrThrow(),
  ]);
  const counts = await db.selectFrom('play_xp').select(['source', (eb) => eb.fn.countAll<string>().as('n')])
    .where('user_id', '=', userId).where('source', 'in', ['training_drill', 'challenge_win']).groupBy('source').execute();
  const countOf = (s: string) => Number(counts.find((c) => c.source === s)?.n ?? 0);
  const xp = Number(total.xp);
  const lvl = levelFor(xp);
  const todayOf = (s: string) => todayRows.filter((r) => r.source === s);
  return {
    xp,
    ...lvl,
    streakDays: streakDays(days.map((d) => d.d), now),
    today: {
      xp: todayRows.reduce((a, r) => a + r.xp, 0),
      roundsLeft: Math.max(0, DAILY_XP_ROUNDS - todayOf('tactics_round').length),
      scanRunsLeft: Math.max(0, DAILY_XP_SCAN_RUNS - todayOf('scan_drill').length),
      drillsDone: todayOf('training_drill').map((r) => r.ref),
    },
    totals: { rounds: Number(rounds.n), bestAnswers: Number(best.n), drills: countOf('training_drill'), challengeWins: countOf('challenge_win') },
  };
}

/** Writes one XP row; false when that (source, ref) was already awarded today. */
async function award(db: Db, userId: string, source: string, ref: string, xp: number, now: Date): Promise<boolean> {
  const res = await db.insertInto('play_xp').values({ user_id: userId, source, ref, xp, day: dayOf(now), created_at: now })
    .onConflict((oc) => oc.columns(['user_id', 'source', 'ref', 'day']).doNothing()).returning('id').executeTakeFirst();
  return Boolean(res);
}

async function awardsToday(db: Db, userId: string, source: string, now: Date): Promise<number> {
  const row = await db.selectFrom('play_xp').select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId).where('source', '=', source).where('day', '=', dayOf(now)).executeTakeFirstOrThrow();
  return Number(row.n);
}

// ---------------------------------------------------------------- rounds

type RoundRow = { id: string; user_id: string; challenge_id: string | null; scenario_ids: string[]; points: number; total_ms: number; xp: number; completed_at: Date | null };

function feedback(scenarioId: string, a: { option_id: string; points: number; ms: number }, xp: number) {
  const s = scenarioById(scenarioId)!;
  return {
    scenarioId, chosenOptionId: a.option_id, points: a.points, ms: a.ms, xp,
    bestOptionId: bestOption(s).id,
    options: s.options.map((o) => ({ id: o.id, points: o.points, why: o.why })),
    lesson: s.lesson,
  };
}

async function roundView(db: Db, round: RoundRow, now: Date): Promise<z.input<typeof PlayRoundView>> {
  const answers = await db.selectFrom('play_answers').select(['scenario_id', 'option_id', 'points', 'ms']).where('round_id', '=', round.id).execute();
  const earnsXp = round.completed_at ? round.xp > 0 : (await awardsToday(db, round.user_id, 'tactics_round', now)) < DAILY_XP_ROUNDS;
  return {
    id: round.id,
    challengeId: round.challenge_id,
    scenarios: round.scenario_ids.map((id) => publicScenario(scenarioById(id)!)),
    answers: round.scenario_ids.flatMap((id) => {
      const a = answers.find((x) => x.scenario_id === id);
      return a ? [feedback(id, a, earnsXp ? answerXp(a.points, a.ms) : 0)] : [];
    }),
    points: round.points,
    maxPoints: round.scenario_ids.length * 2,
    xp: round.xp,
    earnsXp,
    completed: round.completed_at !== null,
  };
}

const roundColumns = ['id', 'user_id', 'challenge_id', 'scenario_ids', 'points', 'total_ms', 'xp', 'completed_at'] as const;

async function ownRound(db: Db, id: string, userId: string, lock = false): Promise<RoundRow> {
  let q = db.selectFrom('play_rounds').select([...roundColumns]).where('id', '=', IdParam.parse(id)).where('user_id', '=', userId);
  if (lock) q = q.forUpdate();
  const r = await q.executeTakeFirst();
  if (!r) throw notFound('round');
  return r;
}

// ---------------------------------------------------------------- friend challenges

/** People I can challenge: mutual follows, active, not blocked, in my age group (or my guardian or ward). */
async function friends(db: Db, me: { userId: string; ageBand: AgeBand; guardianOf: readonly string[] }) {
  const rows = await db.selectFrom('follows as f1')
    .innerJoin('follows as f2', (j) => j.onRef('f2.follower_id', '=', 'f1.followee_id').onRef('f2.followee_id', '=', 'f1.follower_id'))
    .innerJoin('users', 'users.id', 'f1.followee_id')
    .innerJoin('profiles', 'profiles.user_id', 'users.id')
    .leftJoin('age_records', 'age_records.user_id', 'users.id')
    .select(['users.id', 'profiles.handle', 'profiles.display_name', 'age_records.age_band'])
    .where('f1.follower_id', '=', me.userId).where('users.status', '=', 'active')
    .where((eb) => eb.not(eb.exists(eb.selectFrom('blocks').select('blocker_id').where((b) => b.or([
      b.and([b('blocker_id', '=', me.userId), b('blocked_id', '=', b.ref('users.id'))]),
      b.and([b('blocked_id', '=', me.userId), b('blocker_id', '=', b.ref('users.id'))]),
    ])))))
    .orderBy('profiles.handle').limit(200).execute();
  const guardians = new Set((await db.selectFrom('guardian_relationships').select('guardian_user_id')
    .where('minor_user_id', '=', me.userId).where('status', '=', 'active').execute()).map((g) => g.guardian_user_id));
  return rows.filter((r) => canChallenge({
    mutualFollow: true, blocked: false, aBand: me.ageBand, bBand: (r.age_band ?? 'adult') as AgeBand,
    guardianPair: me.guardianOf.includes(r.id) || guardians.has(r.id),
  }).allowed).map((r) => ({ userId: r.id, handle: r.handle, displayName: r.display_name }));
}

async function challengeViews(db: Db, userId: string, now: Date, id?: string): Promise<z.input<typeof PlayChallengeView>[]> {
  // Challenges nobody finished in time expire (lazily, whenever someone looks).
  await db.updateTable('play_challenges').set({ status: 'expired' })
    .where('status', 'in', ['pending', 'accepted']).where('expires_at', '<', now)
    .where((eb) => eb.or([eb('challenger_id', '=', userId), eb('opponent_id', '=', userId)])).execute();
  let q = db.selectFrom('play_challenges as c')
    .innerJoin('profiles as other', (j) => j.on((eb) => eb('other.user_id', '=', eb.case().when('c.challenger_id', '=', userId).then(eb.ref('c.opponent_id')).else(eb.ref('c.challenger_id')).end())))
    .leftJoin('play_rounds as mine', (j) => j.onRef('mine.challenge_id', '=', 'c.id').on('mine.user_id', '=', userId))
    .leftJoin('play_rounds as theirs', (j) => j.onRef('theirs.challenge_id', '=', 'c.id').on('theirs.user_id', '!=', userId))
    .select([
      'c.id', 'c.status', 'c.challenger_id', 'c.winner_id', 'c.scenario_ids', 'c.created_at', 'c.expires_at',
      'other.user_id as other_id', 'other.handle as other_handle', 'other.display_name as other_name',
      'mine.id as my_round', 'mine.points as my_points', 'mine.completed_at as my_done',
      'theirs.points as their_points', 'theirs.completed_at as their_done',
    ])
    .where((eb) => eb.or([eb('c.challenger_id', '=', userId), eb('c.opponent_id', '=', userId)]));
  q = id ? q.where('c.id', '=', id) : q.orderBy('c.created_at', 'desc').limit(30);
  const rows = await q.execute();
  return rows.map((r) => {
    const iFinished = Boolean(r.my_done);
    return {
      id: r.id,
      status: r.status as 'pending',
      role: r.challenger_id === userId ? 'challenger' : 'opponent',
      other: { userId: r.other_id, handle: r.other_handle, displayName: r.other_name },
      myRoundId: r.my_round,
      myPoints: r.my_round ? r.my_points : null,
      myFinished: iFinished,
      theirPoints: iFinished && r.their_done ? r.their_points : null,
      theyFinished: Boolean(r.their_done),
      maxPoints: r.scenario_ids.length * 2,
      result: r.status !== 'completed' ? null : r.winner_id === null ? 'draw' : r.winner_id === userId ? 'won' : 'lost',
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
    };
  });
}

async function oneChallenge(db: Db, userId: string, id: string, now: Date) {
  const c = (await challengeViews(db, userId, now, IdParam.parse(id)))[0];
  if (!c) throw notFound('challenge');
  return c;
}

/** Called in the transaction that completes a challenge round: settles the result once both have played. */
async function settleChallenge(tx: Transaction<DB>, challengeId: string, now: Date) {
  const c = await tx.selectFrom('play_challenges').selectAll().where('id', '=', challengeId).forUpdate().executeTakeFirstOrThrow();
  if (c.status === 'completed' || c.status === 'declined' || c.status === 'expired') return;
  const rounds = await tx.selectFrom('play_rounds').select(['user_id', 'points', 'total_ms', 'completed_at']).where('challenge_id', '=', challengeId).execute();
  const done = rounds.filter((r) => r.completed_at);
  if (done.length < 2) return;
  const [a, b] = done.map((r) => ({ userId: r.user_id, points: r.points, totalMs: r.total_ms })) as [{ userId: string; points: number; totalMs: number }, { userId: string; points: number; totalMs: number }];
  const winner = challengeWinner(a, b);
  await tx.updateTable('play_challenges').set({ status: 'completed', winner_id: winner, completed_at: now }).where('id', '=', challengeId).execute();
  if (winner) await award(tx, winner, 'challenge_win', challengeId, XP_CHALLENGE_WIN, now);
  for (const u of [c.challenger_id, c.opponent_id]) await notify(tx, u, 'challenge.game_result', { playChallengeId: challengeId });
}

// ---------------------------------------------------------------- routes

export const playRoutes = [
  route(
    { method: 'get', path: '/v1/play/me', summary: 'My XP, level, streak and what is left today', tag: 'play', auth: 'user', response: PlayProfile },
    async (ctx) => {
      ctx.authorize({ kind: 'play.use' });
      return playProfile(ctx.deps.db, ctx.me().userId, ctx.deps.now());
    },
  ),

  route(
    { method: 'post', path: '/v1/play/rounds', summary: 'Start a tactics round, alone or for a friend challenge', tag: 'play', auth: 'user', body: PlayStartRoundRequest, response: PlayRoundView, status: 201,
      rateLimit: { max: 60, timeWindow: '1 hour' } },
    async (ctx) => {
      ctx.authorize({ kind: 'play.use' });
      const me = ctx.me();
      const now = ctx.deps.now();
      const db = ctx.deps.db;
      if (!ctx.body.challengeId) {
        const round = await db.insertInto('play_rounds').values({ id: newId(), user_id: me.userId, scenario_ids: drawScenarioIds(ROUND_SIZE), started_at: now })
          .returning([...roundColumns]).executeTakeFirstOrThrow();
        return roundView(db, round, now);
      }
      const round = await db.transaction().execute(async (tx) => {
        const c = await tx.selectFrom('play_challenges').selectAll().where('id', '=', ctx.body.challengeId!)
          .where((eb) => eb.or([eb('challenger_id', '=', me.userId), eb('opponent_id', '=', me.userId)])).forUpdate().executeTakeFirst();
        if (!c) throw notFound('challenge');
        const existing = await tx.selectFrom('play_rounds').select([...roundColumns]).where('challenge_id', '=', c.id).where('user_id', '=', me.userId).executeTakeFirst();
        if (existing) return existing;
        if (c.status !== 'pending' || c.expires_at < now) throw new ApiError(409, 'CHALLENGE_CLOSED', 'this challenge is no longer open');
        if (await blockedEitherWay(tx, c.challenger_id, c.opponent_id)) throw notFound('challenge');
        await tx.updateTable('play_challenges').set({ status: 'accepted' }).where('id', '=', c.id).execute();
        return tx.insertInto('play_rounds').values({ id: newId(), user_id: me.userId, challenge_id: c.id, scenario_ids: c.scenario_ids, started_at: now })
          .returning([...roundColumns]).executeTakeFirstOrThrow();
      });
      return roundView(db, round, now);
    },
  ),

  route(
    { method: 'get', path: '/v1/play/rounds/:roundId', summary: 'One of my tactics rounds', tag: 'play', auth: 'user', response: PlayRoundView },
    async (ctx) => {
      const me = ctx.me();
      return roundView(ctx.deps.db, await ownRound(ctx.deps.db, ctx.params.roundId!, me.userId), ctx.deps.now());
    },
  ),

  route(
    { method: 'post', path: '/v1/play/rounds/:roundId/answers', summary: 'Answer a scenario; returns why each choice is good or bad', tag: 'play', auth: 'user',
      body: PlayAnswerRequest, response: PlayAnswerResponse, rateLimit: { max: 300, timeWindow: '1 hour' } },
    async (ctx) => {
      ctx.authorize({ kind: 'play.use' });
      const me = ctx.me();
      const now = ctx.deps.now();
      const { scenarioId, optionId } = ctx.body;
      const round = await ctx.deps.db.transaction().execute(async (tx) => {
        const r = await ownRound(tx, ctx.params.roundId!, me.userId, true);
        if (r.completed_at) throw conflict('ROUND_COMPLETE', 'this round is finished');
        if (!r.scenario_ids.includes(scenarioId)) throw new ApiError(400, 'SCENARIO_NOT_IN_ROUND', 'that scenario is not part of this round');
        const option = scenarioById(scenarioId)!.options.find((o) => o.id === optionId);
        if (!option) throw new ApiError(400, 'OPTION_UNKNOWN', 'no such option');
        const answered = await tx.selectFrom('play_answers').select(['scenario_id', 'answered_at']).where('round_id', '=', r.id).execute();
        if (answered.some((a) => a.scenario_id === scenarioId)) throw conflict('ALREADY_ANSWERED', 'you already answered this one');
        // Time is the server's: from the round start or the previous answer, whichever is later.
        const since = await tx.selectFrom('play_rounds').select('started_at').where('id', '=', r.id).executeTakeFirstOrThrow();
        const last = answered.reduce((m, a) => (a.answered_at > m ? a.answered_at : m), since.started_at);
        const ms = Math.max(0, now.getTime() - last.getTime());
        const earns = (await awardsToday(tx, me.userId, 'tactics_round', now)) < DAILY_XP_ROUNDS;
        await tx.insertInto('play_answers').values({ round_id: r.id, scenario_id: scenarioId, option_id: optionId, points: option.points, ms, answered_at: now }).execute();
        const complete = answered.length + 1 === r.scenario_ids.length;
        const xp = r.xp + (earns ? answerXp(option.points, ms) : 0);
        const updated = await tx.updateTable('play_rounds')
          .set({ points: r.points + option.points, total_ms: r.total_ms + ms, xp: complete && !earns ? 0 : xp, completed_at: complete ? now : null })
          .where('id', '=', r.id).returning([...roundColumns]).executeTakeFirstOrThrow();
        if (complete && earns && updated.xp > 0) await award(tx, me.userId, 'tactics_round', r.id, updated.xp, now);
        if (complete && r.challenge_id) await settleChallenge(tx, r.challenge_id, now);
        return updated;
      });
      const view = await roundView(ctx.deps.db, round, now);
      return { feedback: view.answers.find((a) => a.scenarioId === scenarioId)!, round: view, profile: await playProfile(ctx.deps.db, me.userId, now) };
    },
  ),

  route(
    { method: 'post', path: '/v1/play/scan', summary: 'Log a scanning-drill run', tag: 'play', auth: 'user', body: PlayScanRequest, response: PlayXpAward, rateLimit: { max: 30, timeWindow: '1 hour' } },
    async (ctx) => {
      ctx.authorize({ kind: 'play.use' });
      const me = ctx.me();
      const now = ctx.deps.now();
      const xp = ctx.body.hits * XP_PER_SCAN_HIT;
      const runs = await awardsToday(ctx.deps.db, me.userId, 'scan_drill', now);
      const ok = runs < DAILY_XP_SCAN_RUNS && xp > 0 && (await award(ctx.deps.db, me.userId, 'scan_drill', `run-${runs + 1}`, xp, now));
      return { xpAwarded: ok ? xp : 0, capped: runs >= DAILY_XP_SCAN_RUNS, profile: await playProfile(ctx.deps.db, me.userId, now) };
    },
  ),

  route(
    { method: 'post', path: '/v1/play/drills/:drillKey/complete', summary: 'Log a training drill (XP once per drill per day)', tag: 'play', auth: 'user', body: PlayDrillRequest, response: PlayXpAward,
      rateLimit: { max: 60, timeWindow: '1 hour' } },
    async (ctx) => {
      ctx.authorize({ kind: 'play.use' });
      const me = ctx.me();
      const now = ctx.deps.now();
      const drill = drillByKey(ctx.params.drillKey!);
      if (!drill) throw notFound('drill');
      const ok = await award(ctx.deps.db, me.userId, 'training_drill', drill.key, drill.xp, now);
      return { xpAwarded: ok ? drill.xp : 0, capped: !ok, profile: await playProfile(ctx.deps.db, me.userId, now) };
    },
  ),

  route(
    { method: 'get', path: '/v1/play/friends', summary: 'People I can challenge (mutual follows in my age group)', tag: 'play', auth: 'user', response: PlayFriendList },
    async (ctx) => {
      ctx.authorize({ kind: 'play.use' });
      return { items: await friends(ctx.deps.db, ctx.me()) };
    },
  ),

  route(
    { method: 'get', path: '/v1/play/challenges', summary: 'My friend challenges', tag: 'play', auth: 'user', response: PlayChallengeList },
    async (ctx) => ({ items: await challengeViews(ctx.deps.db, ctx.me().userId, ctx.deps.now()) }),
  ),

  route(
    { method: 'post', path: '/v1/play/challenges', summary: 'Challenge a friend to the same tactics round', tag: 'play', auth: 'user', body: CreatePlayChallengeRequest, response: PlayChallengeView, status: 201,
      rateLimit: { max: 20, timeWindow: '1 hour' } },
    async (ctx) => {
      const me = ctx.me();
      const now = ctx.deps.now();
      const db = ctx.deps.db;
      const them = ctx.body.opponentId;
      if (them === me.userId) throw new ApiError(400, 'SELF_CHALLENGE', 'you cannot challenge yourself');
      const target = await db.selectFrom('users').leftJoin('age_records', 'age_records.user_id', 'users.id')
        .select(['users.id', 'age_records.age_band']).where('users.id', '=', them).where('users.status', '=', 'active').executeTakeFirst();
      if (!target) throw notFound('user');
      const [blocked, follows, guardian] = await Promise.all([
        blockedEitherWay(db, me.userId, them),
        db.selectFrom('follows').select('follower_id').where((eb) => eb.or([
          eb.and([eb('follower_id', '=', me.userId), eb('followee_id', '=', them)]),
          eb.and([eb('follower_id', '=', them), eb('followee_id', '=', me.userId)]),
        ])).execute(),
        db.selectFrom('guardian_relationships').select('minor_user_id').where('status', '=', 'active').where((eb) => eb.or([
          eb.and([eb('guardian_user_id', '=', me.userId), eb('minor_user_id', '=', them)]),
          eb.and([eb('guardian_user_id', '=', them), eb('minor_user_id', '=', me.userId)]),
        ])).executeTakeFirst(),
      ]);
      if (blocked) throw notFound('user');
      ctx.authorize({ kind: 'play.challenge', opponentBand: (target.age_band ?? 'adult') as AgeBand, mutualFollow: follows.length === 2, blocked, guardianPair: Boolean(guardian) });
      const id = await db.transaction().execute(async (tx) => {
        const open = await tx.selectFrom('play_challenges').select('id').where('challenger_id', '=', me.userId).where('opponent_id', '=', them)
          .where('status', 'in', ['pending', 'accepted']).where('expires_at', '>', now).executeTakeFirst();
        if (open) throw conflict('CHALLENGE_OPEN', 'you already have an open challenge with this friend');
        const cid = newId();
        const scenarioIds = drawScenarioIds(ROUND_SIZE);
        await tx.insertInto('play_challenges').values({
          id: cid, challenger_id: me.userId, opponent_id: them, scenario_ids: scenarioIds, created_at: now,
          expires_at: new Date(now.getTime() + CHALLENGE_DAYS * 86_400_000),
        }).execute();
        await tx.insertInto('play_rounds').values({ id: newId(), user_id: me.userId, challenge_id: cid, scenario_ids: scenarioIds, started_at: now }).execute();
        await notify(tx, them, 'challenge.game_invite', { playChallengeId: cid, userId: me.userId });
        return cid;
      });
      return oneChallenge(db, me.userId, id, now);
    },
  ),

  route(
    { method: 'post', path: '/v1/play/challenges/:challengeId/decline', summary: 'Decline a friend challenge', tag: 'play', auth: 'user', status: 204 },
    async (ctx) => {
      const me = ctx.me();
      const res = await ctx.deps.db.updateTable('play_challenges').set({ status: 'declined' })
        .where('id', '=', IdParam.parse(ctx.params.challengeId)).where('opponent_id', '=', me.userId).where('status', '=', 'pending').executeTakeFirst();
      if (!res.numUpdatedRows) throw notFound('challenge');
    },
  ),
];

/** Account deletion: game history goes with the account; open challenges with the person close. */
export async function erasePlayData(tx: Transaction<DB>, userId: string) {
  await tx.updateTable('play_challenges').set({ status: 'declined' }).where('status', 'in', ['pending', 'accepted'])
    .where((eb) => eb.or([eb('challenger_id', '=', userId), eb('opponent_id', '=', userId)])).execute();
  await tx.deleteFrom('play_rounds').where('user_id', '=', userId).execute();
  await tx.deleteFrom('play_xp').where('user_id', '=', userId).execute();
}

/** Data export: every XP award, with the resulting total and level. */
export async function playExport(db: Database, userId: string) {
  const rows = await db.selectFrom('play_xp').select(['source', 'ref', 'xp', 'created_at']).where('user_id', '=', userId).orderBy('id').execute();
  const xp = rows.reduce((a, r) => a + r.xp, 0);
  return { xp, level: levelFor(xp).level, awards: rows.map((r) => ({ source: r.source, ref: r.ref, xp: r.xp, at: r.created_at.toISOString() })) };
}
