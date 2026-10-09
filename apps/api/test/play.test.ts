import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DAILY_XP_ROUNDS, XP_BEST, XP_CHALLENGE_WIN, XP_FAST_BONUS } from '@fp/domain';
import { SCENARIOS, scenarioById } from '../src/modules/play-scenarios.js';
import { createTestEnv } from './helpers.js';
import type { TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env?.close();
});

type Json = Record<string, any>;
type User = { token: string; userId: string };

async function call(method: string, url: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await env.app.inject({ method: method as 'GET', url, headers, ...(opts.body !== undefined ? { payload: opts.body as Json } : {}) });
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Json };
}

async function newUser(sub: string, handle: string, dob = '1995-04-02'): Promise<User> {
  const token = await env.token(sub);
  const res = await call('POST', '/v1/onboarding/register', { token, body: { handle, displayName: handle, dob, countryCode: 'EG', roles: ['player'] } });
  expect(res.status).toBe(201);
  // Minors start pending guardian consent; these tests are about play, so activate them directly.
  await env.db.updateTable('users').set({ status: 'active' }).where('id', '=', res.body.userId).execute();
  return { token, userId: res.body.userId };
}
const follow = async (a: User, b: User) => expect((await call('PUT', `/v1/users/${b.userId}/follow`, { token: a.token })).status).toBe(204);
const best = (scenarioId: string) => scenarioById(scenarioId)!.options.reduce((x, y) => (y.points > x.points ? y : x)).id;
const worst = (scenarioId: string) => scenarioById(scenarioId)!.options.find((o) => o.points === 0)!.id;

async function playRound(u: User, round: Json, pick: (id: string) => string) {
  let last: Json = {};
  for (const s of round.scenarios) {
    last = await call('POST', `/v1/play/rounds/${round.id}/answers`, { token: u.token, body: { scenarioId: s.id, optionId: pick(s.id) } });
    expect(last.status).toBe(200);
  }
  return last.body;
}

describe('scenario content', () => {
  it('has one best option per scenario, unique ids, and both languages', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      expect(s.options.filter((o) => o.points === 2), s.id).toHaveLength(1);
      expect(s.options.some((o) => o.points === 0), s.id).toBe(true);
      expect(new Set(s.options.map((o) => o.id)).size, s.id).toBe(s.options.length);
      for (const b of [s.prompt, s.lesson, ...s.options.flatMap((o) => [o.label, o.why])]) {
        expect(b.en.trim(), s.id).not.toBe('');
        expect(b.ar.trim(), s.id).not.toBe('');
      }
    }
  });
});

describe('tactics rounds', () => {
  let a: User;
  let b: User;
  beforeAll(async () => {
    a = await newUser('play-a', 'play_a');
    b = await newUser('play-b', 'play_b');
  });

  it('needs a signed-in, registered player', async () => {
    expect((await call('POST', '/v1/play/rounds', { body: {} })).status).toBe(401);
    expect((await call('GET', '/v1/play/me')).status).toBe(401);
  });

  it('hides the answers until you choose, then explains every option and awards XP', async () => {
    const start = await call('POST', '/v1/play/rounds', { token: a.token, body: {} });
    expect(start.status).toBe(201);
    const round = start.body;
    expect(round).toMatchObject({ points: 0, maxPoints: 10, xp: 0, earnsXp: true, completed: false, answers: [] });
    expect(round.scenarios).toHaveLength(5);
    expect(JSON.stringify(round)).not.toMatch(/"points":[12]|"why"|"lesson"/);

    const first = round.scenarios[0].id;
    const other = SCENARIOS.find((s) => !round.scenarios.some((x: Json) => x.id === s.id))!.id;
    expect((await call('POST', `/v1/play/rounds/${round.id}/answers`, { token: a.token, body: { scenarioId: other, optionId: 'a' } })).body.code).toBe('SCENARIO_NOT_IN_ROUND');
    expect((await call('POST', `/v1/play/rounds/${round.id}/answers`, { token: a.token, body: { scenarioId: first, optionId: 'z' } })).body.code).toBe('OPTION_UNKNOWN');
    expect((await call('POST', `/v1/play/rounds/${round.id}/answers`, { token: b.token, body: { scenarioId: first, optionId: 'a' } })).status).toBe(404);

    const ans = await call('POST', `/v1/play/rounds/${round.id}/answers`, { token: a.token, body: { scenarioId: first, optionId: best(first) } });
    expect(ans.status).toBe(200);
    expect(ans.body.feedback).toMatchObject({ scenarioId: first, points: 2, bestOptionId: best(first), xp: XP_BEST + XP_FAST_BONUS });
    expect(ans.body.feedback.options.every((o: Json) => o.why.en && o.why.ar)).toBe(true);
    expect(ans.body.feedback.lesson.en).toBeTruthy();
    expect((await call('POST', `/v1/play/rounds/${round.id}/answers`, { token: a.token, body: { scenarioId: first, optionId: 'a' } })).body.code).toBe('ALREADY_ANSWERED');

    const rest = { ...round, scenarios: round.scenarios.slice(1) };
    const end = await playRound(a, rest, best);
    expect(end.round).toMatchObject({ completed: true, points: 10, xp: 5 * (XP_BEST + XP_FAST_BONUS) });
    expect(end.profile).toMatchObject({ xp: 125, level: 2, tier: 'grassroots', streakDays: 1, today: { roundsLeft: DAILY_XP_ROUNDS - 1 }, totals: { rounds: 1, bestAnswers: 5 } });
    expect((await call('POST', `/v1/play/rounds/${round.id}/answers`, { token: a.token, body: { scenarioId: first, optionId: 'a' } })).body.code).toBe('ROUND_COMPLETE');

    const again = await call('GET', `/v1/play/rounds/${round.id}`, { token: a.token });
    expect(again.body.answers).toHaveLength(5);
    expect((await call('GET', `/v1/play/rounds/${round.id}`, { token: b.token })).status).toBe(404);
  });

  it('turns rounds into practice once the daily XP allowance is used', async () => {
    const day = sql<Date>`(now() AT TIME ZONE 'utc')::date`;
    for (let i = 0; i < DAILY_XP_ROUNDS; i += 1) {
      await env.db.insertInto('play_xp').values({ user_id: b.userId, source: 'tactics_round', ref: `seed-${i}`, xp: 1, day }).execute();
    }
    const round = (await call('POST', '/v1/play/rounds', { token: b.token, body: {} })).body;
    expect(round.earnsXp).toBe(false);
    const end = await playRound(b, round, best);
    expect(end.round).toMatchObject({ completed: true, points: 10, xp: 0 });
    expect(end.profile.xp).toBe(DAILY_XP_ROUNDS);
  });
});

describe('drills', () => {
  it('awards a training drill once per day and refuses unknown drills', async () => {
    const u = await newUser('drill-1', 'drill_one');
    const first = await call('POST', '/v1/play/drills/wall_passes/complete', { token: u.token, body: { count: 42 } });
    expect(first.body).toMatchObject({ xpAwarded: 30, capped: false, profile: { xp: 30, today: { drillsDone: ['wall_passes'] }, totals: { drills: 1 } } });
    expect((await call('POST', '/v1/play/drills/wall_passes/complete', { token: u.token, body: {} })).body).toMatchObject({ xpAwarded: 0, capped: true });
    expect((await call('POST', '/v1/play/drills/nope/complete', { token: u.token, body: {} })).status).toBe(404);
  });

  it('awards three scan runs a day', async () => {
    const u = await newUser('scan-1', 'scan_one');
    for (let i = 0; i < 3; i += 1) expect((await call('POST', '/v1/play/scan', { token: u.token, body: { hits: 7, reps: 10 } })).body.xpAwarded).toBe(21);
    const fourth = await call('POST', '/v1/play/scan', { token: u.token, body: { hits: 10, reps: 10 } });
    expect(fourth.body).toMatchObject({ xpAwarded: 0, capped: true, profile: { xp: 63, today: { scanRunsLeft: 0 } } });
    expect((await call('POST', '/v1/play/scan', { token: u.token, body: { hits: 11, reps: 10 } })).status).toBe(400);
  });
});

describe('friend challenges', () => {
  let ali: User;
  let sara: User;
  let teen: User;
  let parent: User;
  beforeAll(async () => {
    ali = await newUser('ch-ali', 'ch_ali');
    sara = await newUser('ch-sara', 'ch_sara');
    teen = await newUser('ch-teen', 'ch_teen', '2011-03-15');
    parent = await newUser('ch-parent', 'ch_parent');
  });

  it('only between mutual follows', async () => {
    await follow(ali, sara);
    expect((await call('POST', '/v1/play/challenges', { token: ali.token, body: { opponentId: sara.userId } })).body.code).toBe('FRIENDS_ONLY');
    expect((await call('GET', '/v1/play/friends', { token: ali.token })).body.items).toEqual([]);
    await follow(sara, ali);
    expect((await call('GET', '/v1/play/friends', { token: ali.token })).body.items).toEqual([{ userId: sara.userId, handle: 'ch_sara', displayName: 'ch_sara' }]);
    expect((await call('POST', '/v1/play/challenges', { token: ali.token, body: { opponentId: ali.userId } })).body.code).toBe('SELF_CHALLENGE');
  });

  it('plays the same scenarios, hides the score until you finish, and settles the winner', async () => {
    const created = await call('POST', '/v1/play/challenges', { token: ali.token, body: { opponentId: sara.userId } });
    expect(created.status).toBe(201);
    const c = created.body;
    expect(c).toMatchObject({ status: 'pending', role: 'challenger', other: { handle: 'ch_sara' }, myPoints: 0, theirPoints: null, result: null, maxPoints: 10 });
    expect((await call('POST', '/v1/play/challenges', { token: ali.token, body: { opponentId: sara.userId } })).body.code).toBe('CHALLENGE_OPEN');

    const invite = await env.db.selectFrom('notifications').select(['kind', 'payload']).where('user_id', '=', sara.userId).where('kind', '=', 'challenge.game_invite').executeTakeFirst();
    expect(invite?.payload).toMatchObject({ playChallengeId: c.id, userId: ali.userId });

    const aliRound = (await call('GET', `/v1/play/rounds/${c.myRoundId}`, { token: ali.token })).body;
    await playRound(ali, aliRound, best);

    const saraView = (await call('GET', '/v1/play/challenges', { token: sara.token })).body.items[0];
    expect(saraView).toMatchObject({ id: c.id, role: 'opponent', myRoundId: null, theyFinished: true, theirPoints: null });
    const saraRound = (await call('POST', '/v1/play/rounds', { token: sara.token, body: { challengeId: c.id } })).body;
    expect(saraRound.scenarios.map((s: Json) => s.id)).toEqual(aliRound.scenarios.map((s: Json) => s.id));
    expect((await call('POST', '/v1/play/rounds', { token: sara.token, body: { challengeId: c.id } })).body.id).toBe(saraRound.id);
    expect((await call('POST', '/v1/play/rounds', { token: teen.token, body: { challengeId: c.id } })).status).toBe(404);
    await playRound(sara, saraRound, worst);

    const aliAfter = (await call('GET', '/v1/play/challenges', { token: ali.token })).body.items[0];
    expect(aliAfter).toMatchObject({ status: 'completed', result: 'won', myPoints: 10, theirPoints: 0 });
    const saraAfter = (await call('GET', '/v1/play/challenges', { token: sara.token })).body.items[0];
    expect(saraAfter).toMatchObject({ status: 'completed', result: 'lost', myPoints: 0, theirPoints: 10 });
    const aliMe = (await call('GET', '/v1/play/me', { token: ali.token })).body;
    expect(aliMe.totals.challengeWins).toBe(1);
    expect(aliMe.xp).toBe(5 * (XP_BEST + XP_FAST_BONUS) + XP_CHALLENGE_WIN);
    const results = await env.db.selectFrom('notifications').select('user_id').where('kind', '=', 'challenge.game_result').execute();
    expect(results.map((r) => r.user_id).sort()).toEqual([ali.userId, sara.userId].sort());
  });

  it('lets the opponent decline, and closes the challenge to new rounds', async () => {
    const c = (await call('POST', '/v1/play/challenges', { token: sara.token, body: { opponentId: ali.userId } })).body;
    expect((await call('POST', `/v1/play/challenges/${c.id}/decline`, { token: sara.token })).status).toBe(404);
    expect((await call('POST', `/v1/play/challenges/${c.id}/decline`, { token: ali.token })).status).toBe(204);
    expect((await call('POST', '/v1/play/rounds', { token: ali.token, body: { challengeId: c.id } })).body.code).toBe('CHALLENGE_CLOSED');
  });

  it('keeps adults and minors apart unless the adult is the guardian', async () => {
    await follow(teen, ali);
    await follow(ali, teen);
    expect((await call('POST', '/v1/play/challenges', { token: ali.token, body: { opponentId: teen.userId } })).body.code).toBe('AGE_GROUP_MISMATCH');
    expect((await call('POST', '/v1/play/challenges', { token: teen.token, body: { opponentId: ali.userId } })).body.code).toBe('AGE_GROUP_MISMATCH');
    expect((await call('GET', '/v1/play/friends', { token: teen.token })).body.items).toEqual([]);

    await follow(teen, parent);
    await follow(parent, teen);
    await env.db.insertInto('guardian_relationships').values({ guardian_user_id: parent.userId, minor_user_id: teen.userId, status: 'active' }).execute();
    expect((await call('GET', '/v1/play/friends', { token: teen.token })).body.items.map((f: Json) => f.handle)).toEqual(['ch_parent']);
    expect((await call('POST', '/v1/play/challenges', { token: parent.token, body: { opponentId: teen.userId } })).status).toBe(201);
  });

  it('treats a block as if the person did not exist', async () => {
    const x = await newUser('ch-x', 'ch_x');
    await follow(x, sara);
    await follow(sara, x);
    expect((await call('PUT', `/v1/users/${x.userId}/block`, { token: sara.token })).status).toBe(204);
    expect((await call('POST', '/v1/play/challenges', { token: x.token, body: { opponentId: sara.userId } })).status).toBe(404);
  });

  it('erases play history with the account and closes open challenges', async () => {
    const open = await env.db.selectFrom('play_challenges').select('id').where('challenger_id', '=', parent.userId).where('status', '=', 'pending').executeTakeFirstOrThrow();
    await call('POST', '/v1/play/drills/cone_weave/complete', { token: parent.token, body: {} });
    const exp = await call('GET', '/v1/me/export', { token: parent.token });
    expect(exp.status).toBe(200);
    expect(exp.body.play).toMatchObject({ xp: 30, awards: [{ source: 'training_drill', ref: 'cone_weave', xp: 30 }] });
    expect((await call('DELETE', '/v1/me', { token: parent.token, body: { confirm: 'DELETE' } })).body).toEqual({ status: 'deleted' });
    expect(await env.db.selectFrom('play_xp').select('id').where('user_id', '=', parent.userId).execute()).toEqual([]);
    expect(await env.db.selectFrom('play_rounds').select('id').where('user_id', '=', parent.userId).execute()).toEqual([]);
    expect((await env.db.selectFrom('play_challenges').select('status').where('id', '=', open.id).executeTakeFirstOrThrow()).status).toBe('declined');
  });
});
