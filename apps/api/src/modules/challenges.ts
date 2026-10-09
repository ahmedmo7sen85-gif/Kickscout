/**
 * KICKSCOUT Challenges, player side: the hub, a challenge's page, joining and entering, votes,
 * head-to-heads, Scout Picks, leaderboards, results and "my challenges". Admin and judging routes
 * live in challenge-admin.ts and challenge-judging.ts. See docs/challenges.md.
 */
import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import type { DB } from '@fp/db';
import { z } from 'zod';
import {
  AppealRequest, AppealView, ChallengeDetailView, ChallengeHubView, ChallengeList, ChallengeResultsView, ChallengeSubmissionRequest,
  ChallengeSubmissionResponse, CreateHeadToHeadRequest, CursorQuery, EnterChallengeRequest, HeadToHeadView, JoinChallengeRequest,
  LeaderboardQuery, LeaderboardView, MyChallengesView, RecommendedChallengesView, ScoutPickRequest, VideoPage, VoteResponse,
} from '@fp/contracts';
import type { AgeBand, ChallengeCategory, ChallengeDifficulty, Rubric } from '@fp/domain';
import {
  CHALLENGE_DIFFICULTIES, VOTES_PER_CHALLENGE, challengeIndexable, checkEligibility, isBetter, needsSafetyAck, recommendChallenges, voteDecision, weeklyStreak,
} from '@fp/domain';
import { eligibleVotes, recordAgentRun, sendChallengeNotice } from '@fp/worker/challenges';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import type { Ctx } from '../platform/route.js';
import { ApiError, conflict, notFound } from '../platform/errors.js';
import { audit } from '../platform/events.js';
import { newId } from '../platform/ids.js';
import { blockedEitherWay, discoverable, pageOfVideos, toVideoViews, videoQuery } from './media.js';
import {
  agentLog, attemptsUsed, blockedUsers, challengeQuery, challengeViews, isStaff, listable, loadChallenge, mySubmissionViews, phaseOf,
  publicRubric, rankedBoard, rubricRecord, submissionQuery, toChallengeView, toLeaderboardEntry,
} from './challenge-views.js';
import type { ChallengeRow } from './challenge-views.js';
import { enterExistingVideo, joinChallenge, submitToChallenge } from './challenge-entry.js';

export { challengeViews } from './challenge-views.js';

type Bi = { en: string; ar: string };
const SubmissionParam = z.object({ id: z.uuid() });
const ref = (c: { id: string; slug: string; title: unknown }) => ({ id: c.id, slug: c.slug, title: c.title as Bi });

/** Scout Picks each verified scout may give per challenge. */
export const SCOUT_PICKS_PER_CHALLENGE = 3;

async function staffView(ctx: Ctx<any, any>) {
  return ctx.actor ? isStaff(ctx.actor.roles) : false;
}

// ---------------------------------------------------------------- detail

async function detail(ctx: Ctx<any, any>, c: ChallengeRow): Promise<z.input<typeof ChallengeDetailView>> {
  const deps = ctx.deps;
  const now = deps.now();
  const phase = phaseOf(c, now);
  const [rules, rubric, demo] = await Promise.all([
    deps.db.selectFrom('challenge_rules').select(['kind', 'body']).where('challenge_id', '=', c.id).orderBy('kind').orderBy('sort').execute(),
    rubricRecord(deps.db, c.rubric_version_id),
    c.demo_video_id
      ? discoverable(videoQuery(deps.db), ctx.actor).where('videos.id', '=', c.demo_video_id).execute().then((r) => toVideoViews(deps, ctx.actor, r))
      : Promise.resolve([]),
  ]);
  const view = toChallengeView(deps, c);
  const safety = needsSafetyAck({ difficulty: c.difficulty as ChallengeDifficulty, hasSafetyNotes: c.safety_notes !== null });
  let me: z.input<typeof ChallengeDetailView>['me'] = null;
  if (ctx.actor) {
    const actor = ctx.actor;
    const p = await deps.db.selectFrom('challenge_participations').select(['id', 'status', 'safety_ack_at']).where('challenge_id', '=', c.id).where('user_id', '=', actor.userId).executeTakeFirst();
    const used = p ? await attemptsUsed(deps.db, p.id, c.retry_failed) : 0;
    const subs = await submissionQuery(deps.db).where('s.challenge_id', '=', c.id).where('s.user_id', '=', actor.userId).orderBy('s.created_at', 'desc').execute();
    const ranks = new Map<string, number>();
    if (rubric && subs.some((s) => s.state === 'approved')) {
      const board = await rankedBoard(deps.db, c.id, rubric.rubric, 'overall', { final: c.results_published_at !== null, exclude: [] });
      for (const e of board.entries) if (e.row.userId === actor.userId) ranks.set(e.row.submissionId, e.rank);
    }
    const votes = await deps.db.selectFrom('challenge_votes').select('submission_id').where('challenge_id', '=', c.id).where('voter_id', '=', actor.userId).execute();
    const elig = checkEligibility({
      actor, attemptsUsed: used, participation: (p ?? null) as never, othersInClip: false, consentOthers: true, safetyAck: !safety || !!p?.safety_ack_at,
      challenge: {
        phase, ageGroups: c.age_groups as AgeBand[], difficulty: c.difficulty as ChallengeDifficulty, hasSafetyNotes: c.safety_notes !== null,
        requiresPartner: c.requires_partner, attemptLimit: c.attempt_limit,
      },
    });
    me = {
      joined: !!p, participationStatus: (p?.status ?? null) as never, attemptsUsed: used, attemptsLeft: Math.max(0, c.attempt_limit - used),
      eligibility: elig.allowed ? { allowed: true, code: null, reason: null } : { allowed: false, code: elig.code, reason: elig.reason },
      submissions: await mySubmissionViews(deps, subs, ranks),
      votesLeft: Math.max(0, VOTES_PER_CHALLENGE - votes.length), votedFor: votes.map((v) => v.submission_id),
    };
  }
  return {
    ...view,
    instructions: c.instructions as Bi, equipment: c.equipment as Bi[], safetyNotes: (c.safety_notes as Bi | null) ?? null,
    recording: c.recording as never, minDurationS: c.min_duration_s, maxDurationS: c.max_duration_s, attemptLimit: c.attempt_limit,
    retryFailed: c.retry_failed, requiresPartner: c.requires_partner, needsSafetyAck: safety,
    rules: rules.map((r) => ({ kind: r.kind as never, body: r.body as Bi })),
    rubric: rubric ? publicRubric(rubric) : null,
    demoVideo: demo[0] ?? null,
    resultsPublishedAt: c.results_published_at?.toISOString() ?? null,
    indexable: challengeIndexable({
      phase, visibility: c.visibility as 'public' | 'unlisted', isTemplate: c.is_template, isDemo: c.is_demo,
      title: c.title as Bi, description: c.description as Bi, instructions: c.instructions as Bi,
    }).index,
    me,
  };
}

// ---------------------------------------------------------------- entries the viewer may act on

/** An approved entry anyone may see (published, public, active public profile), with its challenge. */
async function publicEntry(deps: Deps, submissionId: string) {
  const s = await deps.db.selectFrom('challenge_submissions as s')
    .innerJoin('challenges as c', 'c.id', 's.challenge_id')
    .innerJoin('videos as v', 'v.id', 's.video_id')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .innerJoin('privacy_settings as ps', 'ps.user_id', 's.user_id')
    .select(['s.id', 's.user_id', 's.challenge_id', 'c.status', 'c.starts_at', 'c.ends_at', 'c.voting_enabled', 'c.is_template', 'c.results_published_at'])
    .where('s.id', '=', submissionId).where('s.state', '=', 'approved')
    .where('v.status', '=', 'published').where('v.visibility', '=', 'public').where('ps.profile_visibility', '=', 'public').where('u.status', '=', 'active')
    .executeTakeFirst();
  if (!s) throw notFound('entry');
  return s;
}

async function ownSubmission(ctx: Ctx<any, any>, id: string) {
  const me = ctx.me();
  const rows = await submissionQuery(ctx.deps.db).where('s.id', '=', id).execute();
  const s = rows[0];
  // Someone else's entry looks missing rather than forbidden.
  if (!s || !(s.user_id === me.userId || me.guardianOf.includes(s.user_id))) throw notFound('entry');
  return s;
}

async function votesLeft(deps: Deps, challengeId: string, voterId: string) {
  const r = await deps.db.selectFrom('challenge_votes').select((eb) => eb.fn.countAll<string>().as('n')).where('challenge_id', '=', challengeId).where('voter_id', '=', voterId).executeTakeFirstOrThrow();
  return Math.max(0, VOTES_PER_CHALLENGE - Number(r.n));
}

// ---------------------------------------------------------------- head-to-heads

async function headToHeadViews(deps: Deps, userId: string, id?: string): Promise<z.input<typeof HeadToHeadView>[]> {
  let q = deps.db.selectFrom('challenge_head_to_heads as h')
    .innerJoin('challenges as c', 'c.id', 'h.challenge_id')
    .innerJoin('profiles as other', (j) => j.on((eb) => eb('other.user_id', '=', eb.case().when('h.challenger_id', '=', userId).then(eb.ref('h.opponent_id')).else(eb.ref('h.challenger_id')).end())))
    .select(['h.id', 'h.status', 'h.challenger_id', 'h.winner_id', 'h.created_at', 'c.id as cid', 'c.slug', 'c.title', 'other.user_id as other_id', 'other.handle', 'other.display_name'])
    .where((eb) => eb.or([eb('h.challenger_id', '=', userId), eb('h.opponent_id', '=', userId)]));
  if (id) q = q.where('h.id', '=', id);
  const rows = await q.orderBy('h.created_at', 'desc').limit(50).execute();
  return rows.map((r) => ({
    id: r.id, challenge: { id: r.cid, slug: r.slug, title: r.title as Bi }, role: r.challenger_id === userId ? 'challenger' : 'opponent',
    other: { userId: r.other_id, handle: r.handle, displayName: r.display_name }, status: r.status as never,
    result: r.status !== 'completed' ? null : r.winner_id === null ? 'draw' : r.winner_id === userId ? 'won' : 'lost',
    createdAt: r.created_at.toISOString(),
  }));
}

async function respondHeadToHead(ctx: Ctx<any, any>, accept: boolean) {
  const me = ctx.me();
  const { id } = SubmissionParam.parse(ctx.params);
  await ctx.deps.db.transaction().execute(async (tx) => {
    const h = await tx.selectFrom('challenge_head_to_heads').selectAll().where('id', '=', id).where('opponent_id', '=', me.userId).forUpdate().executeTakeFirst();
    if (!h) throw notFound('head-to-head');
    if (h.status !== 'pending') throw conflict('H2H_CLOSED', `this head-to-head is ${h.status}`);
    if (accept && (await blockedEitherWay(tx as never, h.challenger_id, h.opponent_id))) throw notFound('head-to-head');
    await tx.updateTable('challenge_head_to_heads').set({ status: accept ? 'accepted' : 'declined', responded_at: ctx.deps.now() }).where('id', '=', id).execute();
  });
  return (await headToHeadViews(ctx.deps, me.userId, id))[0]!;
}

// ---------------------------------------------------------------- my challenges

async function myChallenges(ctx: Ctx<any, any>): Promise<z.input<typeof MyChallengesView>> {
  const deps = ctx.deps;
  const me = ctx.me();
  const now = deps.now();
  const subs = await submissionQuery(deps.db).where('s.user_id', '=', me.userId).orderBy('s.created_at', 'desc').limit(100).execute();
  const subViews = await mySubmissionViews(deps, subs);
  const joined = await challengeQuery(deps.db)
    .innerJoin('challenge_participations as p', 'p.challenge_id', 'challenges.id')
    .select(['p.id as participation_id', 'p.status as participation_status'])
    .where('p.user_id', '=', me.userId).where('challenges.status', 'in', ['scheduled', 'active', 'judging', 'paused']).orderBy('challenges.ends_at').execute();
  const active = [];
  for (const c of joined) {
    const used = await attemptsUsed(deps.db, c.participation_id, c.retry_failed);
    const mine = subViews.filter((s) => s.challenge.id === c.id && s.state === 'approved' && s.score);
    const best = mine.reduce<(typeof mine)[number]['score'] | null>((b, s) => (!b || isBetter(s.score!, s.score!.value, b.value) ? s.score : b), null);
    active.push({ challenge: toChallengeView(deps, c), attemptsUsed: used, attemptsLeft: Math.max(0, c.attempt_limit - used), best });
  }

  const badges = await deps.db.selectFrom('user_challenge_badges as ub').innerJoin('challenge_badges as b', 'b.key', 'ub.badge_key')
    .leftJoin('challenges as c', 'c.id', 'ub.challenge_id')
    .select(['b.key', 'b.name', 'b.description', 'b.icon', 'ub.awarded_at', 'c.id as cid', 'c.slug', 'c.title'])
    .where('ub.user_id', '=', me.userId).orderBy('ub.awarded_at', 'desc').execute();

  // Personal bests per challenge type (template), comparing like units only.
  const approved = await deps.db.selectFrom('challenge_submissions as s').innerJoin('challenges as c', 'c.id', 's.challenge_id')
    .innerJoin('challenge_scores as sc', (j) => j.onRef('sc.submission_id', '=', 's.id').on('sc.superseded_at', 'is', null))
    .innerJoin('challenge_rubric_versions as rv', 'rv.id', 's.rubric_version_id')
    .select(['s.approved_at', 's.created_at', 'c.id', 'c.slug', 'c.title', 'c.template_key', 'sc.value', 'rv.rubric'])
    .where('s.user_id', '=', me.userId).where('s.state', '=', 'approved').execute();
  const pbs = new Map<string, z.input<typeof MyChallengesView>['personalBests'][number]>();
  for (const a of approved) {
    if (!a.template_key) continue;
    const r = a.rubric as unknown as Rubric;
    const key = `${a.template_key}:${r.unit}`;
    const value = Number(a.value);
    const prev = pbs.get(key);
    if (!prev || isBetter(r, value, prev.value)) {
      pbs.set(key, { templateKey: a.template_key, title: a.title as Bi, unit: r.unit, direction: r.direction, value, challenge: ref(a), at: (a.approved_at ?? a.created_at).toISOString() });
    }
  }
  const xp = await deps.db.selectFrom('play_xp').select((eb) => eb.fn.coalesce(eb.fn.sum<string>('xp'), sql<string>`0`).as('n'))
    .where('user_id', '=', me.userId).where('source', 'in', ['challenge_entry', 'challenge_podium', 'challenge_award']).executeTakeFirstOrThrow();

  return {
    active,
    submissions: subViews,
    badges: badges.map((b) => ({
      key: b.key, name: b.name as Bi, description: b.description as Bi, icon: b.icon, awardedAt: b.awarded_at.toISOString(),
      challenge: b.cid ? { id: b.cid, slug: b.slug!, title: b.title as Bi } : null,
    })),
    personalBests: [...pbs.values()],
    streakWeeks: weeklyStreak(approved.map((a) => a.approved_at ?? a.created_at), now),
    challengeXp: Number(xp.n),
    headToHeads: await headToHeadViews(deps, me.userId),
    appeals: subViews.flatMap((s) => (s.appeal ? [s.appeal] : [])),
  };
}

// ---------------------------------------------------------------- hub

const HUB_LIST = 12;

async function hub(ctx: Ctx<any, any>): Promise<z.input<typeof ChallengeHubView>> {
  const deps = ctx.deps;
  const now = deps.now();
  const rows = await listable(challengeQuery(deps.db))
    .where((eb) => eb.or([eb('challenges.ends_at', '>', new Date(now.getTime() - 60 * 86_400_000)), eb('challenges.status', 'in', ['scheduled', 'active'])]))
    .orderBy('challenges.ends_at', 'desc').limit(300).execute();
  // Trending: most new participants in the last week (challenges, never players, are ranked by activity).
  const recent = await deps.db.selectFrom('challenge_participations').select(['challenge_id', sql<string>`count(*)`.as('n')])
    .where('joined_at', '>', new Date(now.getTime() - 7 * 86_400_000)).groupBy('challenge_id').execute();
  const joins = new Map(recent.map((r) => [r.challenge_id, Number(r.n)]));
  const views = rows.map((r) => ({ row: r, view: toChallengeView(deps, r) }));
  const open = views.filter((v) => v.view.phase === 'open');
  const pick = (xs: typeof views) => xs.slice(0, HUB_LIST).map((x) => x.view);
  const byStart = (a: (typeof views)[number], b: (typeof views)[number]) => b.row.starts_at.getTime() - a.row.starts_at.getTime();
  const featured = open.filter((v) => v.row.featured).sort(byStart)[0] ?? open.sort((a, b) => Number(b.view.participants) - Number(a.view.participants))[0];
  return {
    featured: featured?.view ?? null,
    trending: pick(open.filter((v) => (joins.get(v.row.id) ?? 0) > 0).sort((a, b) => (joins.get(b.row.id) ?? 0) - (joins.get(a.row.id) ?? 0))),
    newest: pick([...open].sort(byStart)),
    endingSoon: pick(open.filter((v) => v.row.ends_at.getTime() - now.getTime() <= 72 * 3_600_000).sort((a, b) => a.row.ends_at.getTime() - b.row.ends_at.getTime())),
    beginner: pick(open.filter((v) => v.row.difficulty === 'beginner')),
    advancedFreestyle: pick(open.filter((v) => v.row.category === 'freestyle' && (v.row.difficulty === 'advanced' || v.row.difficulty === 'expert'))),
    upcoming: pick(views.filter((v) => v.view.phase === 'upcoming').sort((a, b) => a.row.starts_at.getTime() - b.row.starts_at.getTime())),
    completed: pick(views.filter((v) => v.view.phase === 'completed' || v.view.phase === 'judging')),
  };
}

// ---------------------------------------------------------------- results

async function results(ctx: Ctx<any, any>, c: ChallengeRow): Promise<z.input<typeof ChallengeResultsView>> {
  const deps = ctx.deps;
  const counts = await deps.db.selectFrom('challenge_submissions').select((eb) => eb.fn.countAll<string>().as('n'))
    .where('challenge_id', '=', c.id).where('state', '=', 'approved').executeTakeFirstOrThrow();
  const base = { participants: Number(c.participants ?? 0), approvedEntries: Number(counts.n) };
  const rubric = await rubricRecord(deps.db, c.rubric_version_id);
  if (!c.results_published_at || !rubric) return { published: false, publishedAt: null, podium: [], communityFavorite: null, scoutPicks: [], ...base };
  const exclude = await blockedUsers(deps.db, ctx.actor?.userId ?? null);
  const board = await rankedBoard(deps.db, c.id, rubric.rubric, 'overall', { final: true, exclude });
  const bySub = new Map(board.entries.map((e) => [e.row.submissionId, e]));
  const awards = await deps.db.selectFrom('user_challenge_badges').select(['badge_key', 'submission_id'])
    .where('challenge_id', '=', c.id).where('badge_key', 'in', ['community_favorite', 'scout_pick']).execute();
  const votes = await eligibleVotes(deps.db, c.id);
  const picks = await deps.db.selectFrom('challenge_scout_picks').select(['submission_id', sql<string>`count(*)`.as('n')]).where('challenge_id', '=', c.id).groupBy('submission_id').execute();
  const pickCount = new Map(picks.map((p) => [p.submission_id, Number(p.n)]));
  const fav = awards.find((a) => a.badge_key === 'community_favorite' && a.submission_id && bySub.has(a.submission_id));
  return {
    published: true, publishedAt: c.results_published_at.toISOString(), ...base,
    podium: board.entries.filter((e) => e.rank <= 3).map((e) => toLeaderboardEntry(deps, e.row, e.rank)),
    communityFavorite: fav ? { ...toLeaderboardEntry(deps, bySub.get(fav.submission_id!)!.row, bySub.get(fav.submission_id!)!.rank), votes: votes.get(fav.submission_id!) ?? 0 } : null,
    scoutPicks: awards.filter((a) => a.badge_key === 'scout_pick' && a.submission_id && bySub.has(a.submission_id))
      .map((a) => ({ ...toLeaderboardEntry(deps, bySub.get(a.submission_id!)!.row, bySub.get(a.submission_id!)!.rank), picks: pickCount.get(a.submission_id!) ?? 0 })),
  };
}

// ---------------------------------------------------------------- routes

export const challengeRoutes = [
  route(
    { method: 'get', path: '/v1/challenges', summary: 'Open and upcoming challenges, then recent ones', tag: 'challenges', auth: 'optional', response: ChallengeList },
    async (ctx) => {
      const items = await challengeViews(ctx.deps, (q) => listable(q).orderBy('challenges.ends_at', 'desc').limit(50));
      const rank = { active: 0, upcoming: 1, ended: 2 } as const;
      return { items: items.sort((a, b) => rank[a.state] - rank[b.state]) };
    },
  ),
  route(
    { method: 'get', path: '/v1/challenges/hub', summary: 'The Challenges hub: featured, trending, new, ending soon, by level, upcoming, completed', tag: 'challenges', auth: 'optional', response: ChallengeHubView },
    async (ctx) => hub(ctx),
  ),
  route(
    { method: 'get', path: '/v1/challenges/recommended', summary: 'Open challenges that fit you (Recommendation Agent)', tag: 'challenges', auth: 'user', response: RecommendedChallengesView },
    async (ctx) => {
      const me = ctx.me();
      const deps = ctx.deps;
      const started = performance.now();
      const now = deps.now();
      const open = (await listable(challengeQuery(deps.db)).where('challenges.status', '=', 'active').where('challenges.ends_at', '>', now).limit(200).execute())
        .filter((c) => (c.age_groups as AgeBand[]).includes(me.ageBand) && phaseOf(c, now) === 'open');
      const history = await deps.db.selectFrom('challenge_submissions as s').innerJoin('challenges as c', 'c.id', 's.challenge_id')
        .select(['c.difficulty', 'c.category']).where('s.user_id', '=', me.userId).where('s.state', '=', 'approved').execute();
      const skills = await deps.db.selectFrom('videos').select('skill_key').distinct().where('owner_user_id', '=', me.userId).where('status', '=', 'published').where('skill_key', 'is not', null).execute();
      const joined = await deps.db.selectFrom('challenge_participations').select('challenge_id').where('user_id', '=', me.userId).execute();
      const ladder = CHALLENGE_DIFFICULTIES as readonly string[];
      const best = history.reduce<string | null>((b, h) => (b === null || ladder.indexOf(h.difficulty) > ladder.indexOf(b) ? h.difficulty : b), null);
      const picks = recommendChallenges(open.map((c) => ({
        id: c.id, difficulty: c.difficulty as ChallengeDifficulty, category: c.category as ChallengeCategory, skillKey: c.skill_key, endsAt: c.ends_at, participants: Number(c.participants ?? 0),
      })), {
        bestApprovedDifficulty: best as ChallengeDifficulty | null, categories: [...new Set(history.map((h) => h.category as ChallengeCategory))],
        skills: skills.map((s) => s.skill_key!), joined: joined.map((j) => j.challenge_id),
      }, now);
      await recordAgentRun(deps.db, agentLog(ctx.req.log), {
        agent: 'recommendation', outcome: 'ok', latencyMs: performance.now() - started, subjectKind: 'user', subjectId: me.userId,
        detail: { candidates: open.length, returned: picks.length },
      });
      const byId = new Map(open.map((c) => [c.id, c]));
      return { items: picks.map((p) => ({ challenge: toChallengeView(deps, byId.get(p.id)!), reasons: p.reasons })) };
    },
  ),
  route(
    { method: 'get', path: '/v1/me/challenges', summary: 'My challenges: active, entries, badges, personal bests, streak, head-to-heads, appeals', tag: 'challenges', auth: 'user', response: MyChallengesView },
    async (ctx) => myChallenges(ctx),
  ),
  route(
    { method: 'get', path: '/v1/challenges/:slug', summary: 'A challenge, with your entries and eligibility when signed in', tag: 'challenges', auth: 'optional', response: ChallengeDetailView },
    async (ctx) => {
      const c = await loadChallenge(ctx.deps, ctx.params.slug!, { staff: await staffView(ctx) });
      await ctx.track('challenge_viewed', { challengeId: c.id });
      return detail(ctx, c);
    },
  ),
  route(
    { method: 'get', path: '/v1/challenges/:slug/entries', summary: 'Approved, public entries to a challenge, newest first', tag: 'challenges', auth: 'optional', query: CursorQuery, response: VideoPage },
    async (ctx) => {
      const c = await loadChallenge(ctx.deps, ctx.params.slug!);
      const q = discoverable(videoQuery(ctx.deps.db), ctx.actor)
        .where('videos.id', 'in', (eb) => eb.selectFrom('challenge_submissions').select('video_id').where('challenge_id', '=', c.id).where('state', '=', 'approved'));
      return pageOfVideos(ctx.deps, ctx.actor, q, ctx.query);
    },
  ),
  route(
    { method: 'get', path: '/v1/challenges/:slug/leaderboard', summary: 'Leaderboard: live while the challenge runs, final once results are published', tag: 'challenges', auth: 'optional', query: LeaderboardQuery, response: LeaderboardView },
    async (ctx) => {
      const c = await loadChallenge(ctx.deps, ctx.params.slug!);
      const rubric = await rubricRecord(ctx.deps.db, c.rubric_version_id);
      if (!rubric) throw notFound('leaderboard');
      const exclude = await blockedUsers(ctx.deps.db, ctx.actor?.userId ?? null);
      const board = await rankedBoard(ctx.deps.db, c.id, rubric.rubric, ctx.query.scope, { final: c.results_published_at !== null, exclude });
      const mine = ctx.actor ? board.entries.find((e) => e.row.userId === ctx.actor!.userId) : undefined;
      return {
        scope: ctx.query.scope, kind: board.kind, unit: rubric.rubric.unit, direction: rubric.rubric.direction, computedAt: board.computedAt.toISOString(),
        entries: board.entries.slice(0, ctx.query.limit).map((e) => toLeaderboardEntry(ctx.deps, e.row, e.rank)),
        me: mine ? toLeaderboardEntry(ctx.deps, mine.row, mine.rank) : null,
      };
    },
  ),
  route(
    { method: 'get', path: '/v1/challenges/:slug/results', summary: 'Published results: podium, Community Favorite, Scout Picks', tag: 'challenges', auth: 'optional', response: ChallengeResultsView },
    async (ctx) => results(ctx, await loadChallenge(ctx.deps, ctx.params.slug!)),
  ),
  route(
    { method: 'post', path: '/v1/challenges/:slug/join', summary: 'Join a challenge (idempotent)', tag: 'challenges', auth: 'user', body: JoinChallengeRequest, status: 204 },
    async (ctx) => {
      await joinChallenge(ctx, ctx.params.slug!, ctx.body);
    },
  ),
  route(
    {
      method: 'post', path: '/v1/challenges/:slug/submissions', summary: 'Enter a new clip: returns a signed upload URL; the clip goes through moderation first',
      tag: 'challenges', auth: 'user', body: ChallengeSubmissionRequest, response: ChallengeSubmissionResponse, status: 201, rateLimit: { max: 20, timeWindow: '1 hour' },
    },
    async (ctx) => submitToChallenge(ctx, ctx.params.slug!, ctx.body) as never,
  ),
  route(
    {
      method: 'post', path: '/v1/challenges/:slug/entries', summary: 'Enter a clip you uploaded while the challenge was open', tag: 'challenges', auth: 'user',
      body: EnterChallengeRequest, response: ChallengeSubmissionResponse, status: 201,
    },
    async (ctx) => {
      const id = await enterExistingVideo(ctx, ctx.params.slug!, ctx.body);
      const s = await ctx.deps.db.selectFrom('challenge_submissions').select(['id', 'video_id', 'state']).where('id', '=', id).executeTakeFirstOrThrow();
      return { submissionId: s.id, videoId: s.video_id, state: s.state as never, upload: null };
    },
  ),
  route(
    { method: 'post', path: '/v1/challenge-submissions/:id/withdraw', summary: 'Withdraw your entry (before results are published)', tag: 'challenges', auth: 'user', status: 204 },
    async (ctx) => {
      const { id } = SubmissionParam.parse(ctx.params);
      const s = await ownSubmission(ctx, id);
      if (s.state === 'withdrawn') return;
      if (s.results_published_at) throw new ApiError(409, 'RESULTS_PUBLISHED', 'results are already published');
      await ctx.deps.db.transaction().execute(async (tx) => {
        const moved = await tx.updateTable('challenge_submissions').set({ state: 'withdrawn', state_reason: 'withdrawn by the player', updated_at: ctx.deps.now() })
          .where('id', '=', id).where('state', '=', s.state).returning('id').executeTakeFirst();
        if (!moved) throw conflict('STATE_CHANGED', 'this entry changed; reload and try again');
        await audit(tx, { actorId: ctx.me().userId, action: 'challenge.submission_withdrawn', targetKind: 'challenge_submission', targetId: id, metadata: { from: s.state } });
      });
    },
  ),
  route(
    { method: 'post', path: '/v1/challenge-submissions/:id/appeal', summary: 'Appeal a decision on your entry', tag: 'challenges', auth: 'user', body: AppealRequest, response: AppealView, status: 201, rateLimit: { max: 10, timeWindow: '1 day' } },
    async (ctx) => {
      const { id } = SubmissionParam.parse(ctx.params);
      const s = await ownSubmission(ctx, id);
      const now = ctx.deps.now();
      const views = await mySubmissionViews(ctx.deps, [s]);
      if (!views[0]!.canAppeal) throw new ApiError(409, 'NOT_APPEALABLE', s.appeal_status === 'open' ? 'an appeal is already open' : 'this decision cannot be appealed');
      const appealId = newId();
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.insertInto('challenge_appeals').values({ id: appealId, submission_id: id, user_id: s.user_id, reason: ctx.body.reason }).execute();
        await audit(tx, { actorId: ctx.me().userId, action: 'challenge.appeal_opened', targetKind: 'challenge_submission', targetId: id, metadata: { appealId } });
      }).catch((err: { code?: string }) => {
        if (err.code === '23505') throw conflict('NOT_APPEALABLE', 'an appeal is already open');
        throw err;
      });
      return {
        id: appealId, submissionId: id, challenge: { id: s.challenge_id, slug: s.slug, title: s.title as Bi }, reason: ctx.body.reason,
        status: 'open' as const, resolution: null, createdAt: now.toISOString(), resolvedAt: null,
      };
    },
  ),
  route(
    { method: 'post', path: '/v1/challenge-submissions/:id/vote', summary: 'Vote for an entry (Community Favorite; never affects the score)', tag: 'challenges', auth: 'user', response: VoteResponse, rateLimit: { max: 30, timeWindow: '1 minute' } },
    async (ctx) => {
      ctx.authorize({ kind: 'social.engage' });
      const me = ctx.me();
      const { id } = SubmissionParam.parse(ctx.params);
      const s = await publicEntry(ctx.deps, id);
      const now = ctx.deps.now();
      const phase = phaseOf({ status: s.status, starts_at: s.starts_at, ends_at: s.ends_at }, now);
      const result = await ctx.deps.db.transaction().execute(async (tx) => {
        // One voter at a time per challenge, so parallel requests cannot exceed the vote budget.
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`vote:${s.challenge_id}:${me.userId}`}))`.execute(tx);
        const already = await tx.selectFrom('challenge_votes').select('submission_id').where('submission_id', '=', id).where('voter_id', '=', me.userId).executeTakeFirst();
        if (already) return { counted: false, fresh: false };
        const used = await tx.selectFrom('challenge_votes').select((eb) => eb.fn.countAll<string>().as('n')).where('challenge_id', '=', s.challenge_id).where('voter_id', '=', me.userId).executeTakeFirstOrThrow();
        const voter = await tx.selectFrom('users').select('created_at').where('id', '=', me.userId).executeTakeFirstOrThrow();
        const d = voteDecision({
          isOwner: s.user_id === me.userId, isGuardianOfOwner: me.guardianOf.includes(s.user_id), blocked: await blockedEitherWay(tx as never, me.userId, s.user_id),
          votesUsed: Number(used.n), voterAccountAgeMs: now.getTime() - voter.created_at.getTime(),
          votingOpen: s.voting_enabled && !s.results_published_at && (phase === 'open' || phase === 'judging'),
        });
        if (!d.allowed) throw d.code === 'NOT_FOUND' ? notFound('entry') : new ApiError(d.code === 'VOTES_USED' ? 409 : 403, d.code, d.reason);
        await tx.insertInto('challenge_votes').values({ challenge_id: s.challenge_id, submission_id: id, voter_id: me.userId, eligible: d.eligible, flag_reason: d.flag }).execute();
        return { counted: d.eligible, fresh: true };
      });
      if (result.fresh) await ctx.track('challenge_voted', { challengeId: s.challenge_id });
      return { counted: result.counted, votesLeft: await votesLeft(ctx.deps, s.challenge_id, me.userId) };
    },
  ),
  route(
    { method: 'delete', path: '/v1/challenge-submissions/:id/vote', summary: 'Take back a vote while voting is open', tag: 'challenges', auth: 'user', response: VoteResponse },
    async (ctx) => {
      const me = ctx.me();
      const { id } = SubmissionParam.parse(ctx.params);
      const s = await ctx.deps.db.selectFrom('challenge_submissions as s').innerJoin('challenges as c', 'c.id', 's.challenge_id')
        .select(['s.challenge_id', 'c.results_published_at']).where('s.id', '=', id).executeTakeFirst();
      if (!s) throw notFound('entry');
      if (s.results_published_at) throw new ApiError(403, 'VOTING_CLOSED', 'voting is closed for this challenge');
      await ctx.deps.db.deleteFrom('challenge_votes').where('submission_id', '=', id).where('voter_id', '=', me.userId).execute();
      return { counted: false, votesLeft: await votesLeft(ctx.deps, s.challenge_id, me.userId) };
    },
  ),
  route(
    { method: 'post', path: '/v1/challenges/:slug/head-to-heads', summary: 'Challenge a friend to a head-to-head in this challenge', tag: 'challenges', auth: 'user', body: CreateHeadToHeadRequest, response: HeadToHeadView, status: 201, rateLimit: { max: 20, timeWindow: '1 day' } },
    async (ctx) => {
      const me = ctx.me();
      const deps = ctx.deps;
      const c = await loadChallenge(deps, ctx.params.slug!);
      if (phaseOf(c, deps.now()) !== 'open') throw new ApiError(400, 'CHALLENGE_NOT_OPEN', 'this challenge is not open');
      const them = ctx.body.opponentId;
      if (them === me.userId) throw new ApiError(400, 'SELF', 'pick someone else');
      const other = await deps.db.selectFrom('users').leftJoin('age_records', 'age_records.user_id', 'users.id')
        .select(['users.id', 'age_records.age_band']).where('users.id', '=', them).where('users.status', '=', 'active').executeTakeFirst();
      if (!other) throw notFound('user');
      const [mutual, blocked, guardian] = await Promise.all([
        deps.db.selectFrom('follows as f1').innerJoin('follows as f2', (j) => j.onRef('f2.follower_id', '=', 'f1.followee_id').onRef('f2.followee_id', '=', 'f1.follower_id'))
          .select('f1.follower_id').where('f1.follower_id', '=', me.userId).where('f1.followee_id', '=', them).executeTakeFirst(),
        blockedEitherWay(deps.db, me.userId, them),
        deps.db.selectFrom('guardian_relationships').select('guardian_user_id').where('status', '=', 'active')
          .where((eb) => eb.or([eb.and([eb('guardian_user_id', '=', them), eb('minor_user_id', '=', me.userId)]), eb.and([eb('guardian_user_id', '=', me.userId), eb('minor_user_id', '=', them)])]))
          .executeTakeFirst(),
      ]);
      if (blocked) throw notFound('user');
      ctx.authorize({ kind: 'play.challenge', opponentBand: (other.age_band ?? 'adult') as AgeBand, mutualFollow: !!mutual, blocked, guardianPair: !!guardian });
      if (!(c.age_groups as AgeBand[]).includes((other.age_band ?? 'adult') as AgeBand)) throw new ApiError(403, 'AGE_GROUP_NOT_ELIGIBLE', 'they cannot enter this challenge');
      const id = newId();
      await deps.db.transaction().execute(async (tx) => {
        await tx.insertInto('challenge_head_to_heads').values({ id, challenge_id: c.id, challenger_id: me.userId, opponent_id: them }).execute();
        await sendChallengeNotice(tx, { userId: them, kind: 'challenge.h2h_invite', dedupeKey: `h2h:${id}:invite`, payload: { challengeSlug: c.slug, challenge: { slug: c.slug, title: c.title }, headToHeadId: id } });
      }).catch((err: { code?: string }) => {
        if (err.code === '23505') throw conflict('H2H_EXISTS', 'you already have an open head-to-head with them here');
        throw err;
      });
      return (await headToHeadViews(deps, me.userId, id))[0]!;
    },
  ),
  route(
    { method: 'post', path: '/v1/challenge-head-to-heads/:id/accept', summary: 'Accept a head-to-head', tag: 'challenges', auth: 'user', response: HeadToHeadView },
    async (ctx) => respondHeadToHead(ctx, true),
  ),
  route(
    { method: 'post', path: '/v1/challenge-head-to-heads/:id/decline', summary: 'Decline a head-to-head', tag: 'challenges', auth: 'user', response: HeadToHeadView },
    async (ctx) => respondHeadToHead(ctx, false),
  ),
  route(
    { method: 'post', path: '/v1/challenges/:slug/scout-picks', summary: 'Pick an entry as a verified scout (Scout Pick award)', tag: 'challenges', auth: 'user', body: ScoutPickRequest, status: 204 },
    async (ctx) => {
      ctx.authorize({ kind: 'challenge.scout_pick' });
      const me = ctx.me();
      const c = await loadChallenge(ctx.deps, ctx.params.slug!);
      const phase = phaseOf(c, ctx.deps.now());
      if (!(phase === 'open' || phase === 'judging') || c.results_published_at) throw new ApiError(400, 'PICKS_CLOSED', 'Scout Picks are closed for this challenge');
      const s = await publicEntry(ctx.deps, ctx.body.submissionId);
      if (s.challenge_id !== c.id) throw notFound('entry');
      if (s.user_id === me.userId || (await blockedEitherWay(ctx.deps.db, me.userId, s.user_id))) throw notFound('entry');
      await ctx.deps.db.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`pick:${c.id}:${me.userId}`}))`.execute(tx);
        const mine = await tx.selectFrom('challenge_scout_picks').select('submission_id').where('challenge_id', '=', c.id).where('scout_id', '=', me.userId).execute();
        if (mine.some((m) => m.submission_id === s.id)) return;
        if (mine.length >= SCOUT_PICKS_PER_CHALLENGE) throw conflict('PICKS_USED', `you have used your ${SCOUT_PICKS_PER_CHALLENGE} Scout Picks here`);
        await tx.insertInto('challenge_scout_picks').values({ challenge_id: c.id, scout_id: me.userId, submission_id: s.id }).execute();
        await audit(tx, { actorId: me.userId, action: 'challenge.scout_pick', targetKind: 'challenge_submission', targetId: s.id, metadata: { challengeId: c.id } });
      });
    },
  ),
];

// ---------------------------------------------------------------- account export and erasure

/** Data export: participations, entries with scores, votes given, appeals and badges. */
export async function challengeExport(db: Deps['db'], userId: string) {
  const [parts, subs, votes, appeals, badges] = await Promise.all([
    db.selectFrom('challenge_participations as p').innerJoin('challenges as c', 'c.id', 'p.challenge_id').select(['c.slug', 'p.status', 'p.joined_at']).where('p.user_id', '=', userId).execute(),
    db.selectFrom('challenge_submissions as s').innerJoin('challenges as c', 'c.id', 's.challenge_id')
      .leftJoin('challenge_scores as sc', (j) => j.onRef('sc.submission_id', '=', 's.id').on('sc.superseded_at', 'is', null))
      .select(['s.id', 'c.slug', 's.video_id', 's.attempt_no', 's.state', 's.claimed_value', 'sc.value', 's.created_at']).where('s.user_id', '=', userId).orderBy('s.created_at').execute(),
    db.selectFrom('challenge_votes').select(['submission_id', 'created_at']).where('voter_id', '=', userId).execute(),
    db.selectFrom('challenge_appeals').select(['submission_id', 'reason', 'status', 'created_at']).where('user_id', '=', userId).execute(),
    db.selectFrom('user_challenge_badges as b').leftJoin('challenges as c', 'c.id', 'b.challenge_id').select(['b.badge_key', 'c.slug', 'b.awarded_at']).where('b.user_id', '=', userId).execute(),
  ]);
  return {
    participations: parts.map((p) => ({ challengeSlug: p.slug, status: p.status, joinedAt: p.joined_at.toISOString() })),
    submissions: subs.map((s) => ({
      id: s.id, challengeSlug: s.slug, videoId: s.video_id, attemptNo: s.attempt_no, state: s.state,
      claimedValue: s.claimed_value === null ? null : Number(s.claimed_value), score: s.value === null ? null : Number(s.value), createdAt: s.created_at.toISOString(),
    })),
    votes: votes.map((v) => ({ submissionId: v.submission_id, at: v.created_at.toISOString() })),
    appeals: appeals.map((a) => ({ submissionId: a.submission_id, reason: a.reason, status: a.status, createdAt: a.created_at.toISOString() })),
    badges: badges.map((b) => ({ badge: b.badge_key, challengeSlug: b.slug ?? null, at: b.awarded_at.toISOString() })),
  };
}

/**
 * Account deletion: entries are withdrawn (they leave every leaderboard and result), and votes,
 * Scout Picks, badges, appeals and open head-to-heads go. Published result snapshots keep only ids,
 * and every reader re-filters them against active public accounts, so the person no longer appears.
 */
export async function eraseChallengeData(tx: Transaction<DB>, userId: string) {
  const now = new Date();
  await tx.updateTable('challenge_submissions').set({ state: 'withdrawn', state_reason: 'account deleted', updated_at: now })
    .where('user_id', '=', userId).where('state', '!=', 'withdrawn').execute();
  await tx.updateTable('challenge_participations').set({ status: 'withdrawn' }).where('user_id', '=', userId).execute();
  await tx.updateTable('challenge_head_to_heads').set({ status: 'cancelled' }).where('status', 'in', ['pending', 'accepted'])
    .where((eb) => eb.or([eb('challenger_id', '=', userId), eb('opponent_id', '=', userId)])).execute();
  await tx.deleteFrom('challenge_votes').where('voter_id', '=', userId).execute();
  await tx.deleteFrom('challenge_scout_picks').where('scout_id', '=', userId).execute();
  await tx.deleteFrom('challenge_judges').where('user_id', '=', userId).execute();
  await tx.deleteFrom('user_challenge_badges').where('user_id', '=', userId).execute();
  await tx.deleteFrom('challenge_appeals').where('user_id', '=', userId).execute();
  await tx.deleteFrom('challenge_notifications').where('user_id', '=', userId).execute();
}
