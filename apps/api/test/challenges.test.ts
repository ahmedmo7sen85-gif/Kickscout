/**
 * KICKSCOUT Challenges acceptance tests against a real Postgres: templates and admin, the entry
 * flow through moderation, blind judging, leaderboards, votes, appeals, picks, head-to-heads,
 * results, SEO and account deletion, plus concurrency on submissions and votes.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncSubmissionForVideo } from '@fp/worker/challenges';
import { createTestEnv } from './helpers.js';
import type { TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv({ MAX_UPLOADS_PER_DAY: 100, MAX_ACTIVE_VIDEOS: 100 });
});
afterAll(async () => {
  await env?.close();
});

type Json = Record<string, any>;
type User = { token: string; userId: string; handle: string };
const MFA = { amr: [{ method: 'totp' }], aal: 'aal2' };

async function call(method: string, url: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await env.app.inject({ method: method as 'GET', url, headers, ...(opts.body !== undefined ? { payload: opts.body as Json } : {}) });
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Json };
}

async function newUser(sub: string, handle: string, opts: { roles?: string[]; mfa?: boolean; ageDays?: number } = {}): Promise<User> {
  const token = await env.token(sub);
  const res = await call('POST', '/v1/onboarding/register', { token, body: { handle, displayName: handle, dob: '1995-04-02', countryCode: 'EG', roles: ['player'] } });
  expect(res.status).toBe(201);
  const userId = res.body.userId as string;
  for (const role of opts.roles ?? []) await env.db.insertInto('user_roles').values({ user_id: userId, role: role as never }).execute();
  // Accounts in these tests are old enough for their votes to count unless a test says otherwise.
  await env.db.updateTable('users').set({ created_at: new Date(Date.now() - (opts.ageDays ?? 30) * 86_400_000) }).where('id', '=', userId).execute();
  return { token: opts.mfa ? await env.token(sub, MFA) : token, userId, handle };
}

const key = () => randomBytes(12).toString('hex');
const clip = (extra: Json = {}) => ({ contentType: 'video/mp4', sizeBytes: 1000, title: 'My entry', rightsConfirmed: true, idempotencyKey: key(), ...extra });

/** The file arrives and the worker takes it; the safety pipeline then decides. */
async function arrive(token: string, entry: Json) {
  env.storage.objects.set(new URL(entry.upload.url).pathname.slice(1), { sizeBytes: 1000, contentType: 'video/mp4' });
  expect((await call('POST', `/v1/uploads/${entry.videoId}/complete`, { token })).status).toBe(200);
  await syncSubmissionForVideo(env.db, entry.videoId);
}
async function moderate(videoId: string, outcome: 'published' | 'rejected') {
  await env.db.updateTable('videos').set({
    status: outcome, moderation: outcome === 'published' ? 'safe' : 'rejected', playback_key: `playback/${videoId}.mp4`, thumbnail_key: `thumbs/${videoId}.jpg`,
    duration_ms: 20_000, published_at: outcome === 'published' ? new Date() : null, status_reason: outcome === 'rejected' ? 'not football' : null,
  }).where('id', '=', videoId).execute();
  return syncSubmissionForVideo(env.db, videoId);
}
/** Submit, upload and publish: the entry ends up waiting for judges. */
async function enter(u: User, slug: string, extra: Json = {}) {
  const r = await call('POST', `/v1/challenges/${slug}/submissions`, { token: u.token, body: clip(extra) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await arrive(u.token, r.body);
  expect(await moderate(r.body.videoId, 'published')).toMatchObject({ to: 'pending_judging' });
  return r.body as { submissionId: string; videoId: string };
}
const judge = (u: User, submissionId: string, body: Json) => call('POST', `/v1/judge/challenge-submissions/${submissionId}/reviews`, { token: u.token, body });

describe('KICKSCOUT Challenges', () => {
  let admin: User;
  let j1: User;
  let j2: User;
  let p1: User;
  let p2: User;
  let p3: User;
  let scout: User;
  let challengeId: string;
  const slug = 'juggling-week-1';
  const subs: Record<string, string> = {};

  beforeAll(async () => {
    admin = await newUser('ch-admin', 'ch_admin', { roles: ['admin'], mfa: true });
    j1 = await newUser('ch-j1', 'ch_judge_one', { mfa: true });
    j2 = await newUser('ch-j2', 'ch_judge_two', { mfa: true });
    p1 = await newUser('ch-p1', 'ch_player_one', { mfa: true });
    p2 = await newUser('ch-p2', 'ch_player_two');
    p3 = await newUser('ch-p3', 'ch_player_three');
    scout = await newUser('ch-scout', 'ch_scout', { roles: ['scout'] });
    for (const p of [p1, p2]) await call('PATCH', `/v1/profiles/${p.userId}`, { token: p.token, body: { regionCode: 'EG' } });
  });

  it('installs the twelve templates once and keeps them private', async () => {
    expect((await call('POST', '/v1/admin/challenges/templates/install', { token: p1.token })).status).toBe(403);
    const first = await call('POST', '/v1/admin/challenges/templates/install', { token: admin.token });
    expect(first.body.installed).toHaveLength(12);
    expect((await call('POST', '/v1/admin/challenges/templates/install', { token: admin.token })).body).toMatchObject({ installed: [], skipped: expect.arrayContaining(['tpl-juggling-king']) });
    expect((await call('GET', '/v1/challenges/tpl-juggling-king')).status).toBe(404);
    const list = await call('GET', '/v1/admin/challenges?templates=true', { token: admin.token });
    expect(list.body.items).toHaveLength(12);
    expect(list.body.items.every((t: Json) => t.isTemplate && t.status === 'draft' && t.rules.length >= 4 && t.rubric)).toBe(true);
  });

  it('creates a challenge from a template as a draft, publishes it and freezes the rubric', async () => {
    const created = await call('POST', '/v1/admin/challenges', {
      token: admin.token,
      body: { slug, fromTemplate: 'tpl-juggling-king', startsAt: new Date(Date.now() - 3_600_000).toISOString(), endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), attemptLimit: 3 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', isTemplate: false, templateKey: 'juggling_king', rubric: { method: 'measured', unit: 'count', frozen: false } });
    challengeId = created.body.id;
    expect((await call('GET', `/v1/challenges/${slug}`)).status).toBe(404);
    const published = await call('POST', `/v1/admin/challenges/${challengeId}/transition`, { token: admin.token, body: { action: 'publish' } });
    expect(published.body).toMatchObject({ status: 'active', phase: 'open', rubric: { frozen: true } });
    const rubric = (await call('GET', `/v1/admin/challenges/${challengeId}`, { token: admin.token })).body.rubric;
    expect((await call('POST', `/v1/admin/challenges/${challengeId}/rubric`, { token: admin.token, body: { rubric: { ...rubric, tolerance: 5 } } })).body.code).toBe('RUBRIC_FROZEN');
    expect((await call('PATCH', `/v1/admin/challenges/${challengeId}`, { token: admin.token, body: { attemptLimit: 5 } })).body.code).toBe('CHALLENGE_STARTED');
    expect((await call('PATCH', `/v1/admin/challenges/${challengeId}`, { token: admin.token, body: { featured: true } })).body.featured).toBe(true);
    const page = await call('GET', `/v1/challenges/${slug}`);
    expect(page.body).toMatchObject({ phase: 'open', featured: true, me: null, rubric: { method: 'measured', frozen: true } });
    expect(page.body.rubric.aiCapability).toBeUndefined();
    expect((await call('GET', '/v1/challenges/hub')).body.featured.slug).toBe(slug);
  });

  it('enters through the moderation pipeline, idempotently, and never shows an unapproved clip', async () => {
    const body = clip({ claimedValue: 50 });
    const first = await call('POST', `/v1/challenges/${slug}/submissions`, { token: p1.token, body });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ state: 'pending_upload', upload: { method: 'PUT' } });
    // Resends with the same key (lost responses, double taps) return the same entry.
    const again = await Promise.all(Array.from({ length: 5 }, () => call('POST', `/v1/challenges/${slug}/submissions`, { token: p1.token, body })));
    expect(new Set(again.map((r) => r.body.submissionId))).toEqual(new Set([first.body.submissionId]));
    expect(again.every((r) => r.body.upload)).toBe(true);
    subs.p1 = first.body.submissionId;

    await arrive(p1.token, first.body);
    expect((await call('GET', `/v1/challenges/${slug}`, { token: p1.token })).body.me).toMatchObject({ joined: true, attemptsUsed: 1, submissions: [{ state: 'processing', claimedValue: 50 }] });
    // Nothing about the clip is public while it is in the pipeline.
    expect((await call('GET', `/v1/videos/${first.body.videoId}`)).status).toBe(404);
    expect((await call('GET', `/v1/challenges/${slug}/entries`)).body.items).toEqual([]);
    expect((await call('GET', `/v1/challenges/${slug}/leaderboard`)).body.entries).toEqual([]);
    expect(await moderate(first.body.videoId, 'published')).toMatchObject({ to: 'pending_judging' });
    // Published but not judged: still not on the challenge's lists.
    expect((await call('GET', `/v1/challenges/${slug}/entries`)).body.items).toEqual([]);
    const check = await env.db.selectFrom('challenge_submission_reviews').select(['decision', 'agent']).where('submission_id', '=', subs.p1).execute();
    expect(check).toEqual([{ decision: 'pass', agent: 'verification' }]);
  });

  it('enforces the attempt limit when entries race', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => call('POST', `/v1/challenges/${slug}/submissions`, { token: p2.token, body: clip() })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status !== 201).every((r) => r.body.code === 'ATTEMPTS_USED')).toBe(true);
    const ok = results.filter((r) => r.status === 201).map((r) => r.body);
    for (const e of ok) await arrive(p2.token, e);
    for (const e of ok) await moderate(e.videoId, 'published');
    [subs.p2a, subs.p2b, subs.p2c] = ok.map((e) => e.submissionId as string);
  });

  it('does not count a clip the safety pipeline rejected when retries are allowed', async () => {
    const r = await call('POST', `/v1/challenges/${slug}/submissions`, { token: p3.token, body: clip() });
    await arrive(p3.token, r.body);
    expect(await moderate(r.body.videoId, 'rejected')).toMatchObject({ to: 'rejected' });
    const me = (await call('GET', `/v1/challenges/${slug}`, { token: p3.token })).body.me;
    expect(me).toMatchObject({ attemptsUsed: 0, attemptsLeft: 3, submissions: [{ state: 'rejected', stateReason: 'not football' }] });
    const notice = await env.db.selectFrom('notifications').select('kind').where('user_id', '=', p3.userId).execute();
    expect(notice.map((n) => n.kind)).toContain('challenge.submission_rejected');
    subs.p3 = (await enter(p3, slug)).submissionId;
  });

  it('judges blind, with MFA, never your own entry, and asks a second judge when the count differs from the claim', async () => {
    expect((await call('GET', '/v1/judge/challenges/queue', { token: j1.token })).status).toBe(403);
    expect((await call('PUT', `/v1/admin/challenges/${challengeId}/judges`, { token: admin.token, body: { userIds: [j1.userId, j2.userId, p1.userId] } })).status).toBe(200);
    const noMfa = await env.token('ch-j1');
    expect((await call('GET', '/v1/judge/challenges/queue', { token: noMfa })).body.code).toBe('MFA_REQUIRED');
    const queue = await call('GET', '/v1/judge/challenges/queue', { token: j1.token });
    expect(queue.body.items.map((i: Json) => i.submissionId)).toContain(subs.p1);
    const raw = JSON.stringify(queue.body);
    for (const p of [p1, p2, p3]) {
      expect(raw).not.toContain(p.userId);
      expect(raw).not.toContain(p.handle);
    }
    // A judge who is also a player never sees or judges their own entry.
    expect((await call('GET', '/v1/judge/challenges/queue', { token: p1.token })).body.items.map((i: Json) => i.submissionId)).not.toContain(subs.p1);
    expect((await judge(p1, subs.p1!, { decision: 'score', components: { touches: 99 } })).body.code).toBe('CONFLICT_OF_INTEREST');
    expect((await judge(j1, subs.p1!, { decision: 'score', components: { touches: 9999 } })).body.code).toBe('INVALID_SCORE');
    expect((await judge(j1, subs.p1!, { decision: 'score', components: { touches: 40 } })).body).toEqual({ state: 'pending_judging', outcome: 'need_more' });
    expect((await judge(j1, subs.p1!, { decision: 'score', components: { touches: 40 } })).body.code).toBe('ALREADY_REVIEWED');
    const item = (await call('GET', `/v1/judge/challenge-submissions/${subs.p1}`, { token: j2.token })).body;
    expect(item).toMatchObject({ claimedValue: 50, judgesNeeded: 2, reviewsThisRound: 1, flags: ['claim_mismatch'] });
    expect((await judge(j2, subs.p1!, { decision: 'score', components: { touches: 41 } })).body).toEqual({ state: 'approved', outcome: 'approved' });
    const mine = (await call('GET', `/v1/challenges/${slug}`, { token: p1.token })).body.me.submissions[0];
    // Measured scores take the more conservative of the agreeing counts.
    expect(mine).toMatchObject({ state: 'approved', rank: 1, score: { value: 40, method: 'measured', reviewStatus: 'confirmed', rubricVersion: 1 } });
  });

  it('sends a disagreement to an admin instead of averaging it', async () => {
    await env.db.updateTable('challenge_submissions').set({ claimed_value: '30' }).where('id', '=', subs.p2a!).execute();
    expect((await judge(j1, subs.p2a!, { decision: 'score', components: { touches: 10 } })).body.outcome).toBe('need_more');
    expect((await judge(j2, subs.p2a!, { decision: 'score', components: { touches: 20 } })).body).toEqual({ state: 'pending_judging', outcome: 'disagreement' });
    expect((await call('GET', '/v1/judge/challenges/queue', { token: j2.token })).body.items.map((i: Json) => i.submissionId)).not.toContain(subs.p2a);
    expect((await judge(j2, subs.p2a!, { decision: 'score', components: { touches: 15 } })).body.code).toBe('ADMIN_REVIEW');
    const adminQueue = await call('GET', '/v1/judge/challenges/queue', { token: admin.token });
    expect(adminQueue.body.items.find((i: Json) => i.submissionId === subs.p2a).flags).toContain('disagreement');
    expect((await judge(admin, subs.p2a!, { decision: 'score', components: { touches: 12 } })).body).toEqual({ state: 'approved', outcome: 'approved' });
    expect((await judge(j1, subs.p2b!, { decision: 'score', components: { touches: 25 } })).body.outcome).toBe('approved');
    expect((await judge(j1, subs.p3!, { decision: 'score', components: { touches: 30 } })).body.outcome).toBe('approved');
  });

  it('ranks the best entry per player, by country only for players who show it, and hides blocked players', async () => {
    const board = (await call('GET', `/v1/challenges/${slug}/leaderboard`)).body;
    expect(board).toMatchObject({ kind: 'live', unit: 'count', direction: 'higher' });
    expect(board.entries.map((e: Json) => [e.player.handle, e.value, e.rank])).toEqual([['ch_player_one', 40, 1], ['ch_player_three', 30, 2], ['ch_player_two', 25, 3]]);
    expect((await call('GET', `/v1/challenges/${slug}/leaderboard?scope=EG`)).body.entries.map((e: Json) => e.player.handle)).toEqual(['ch_player_one', 'ch_player_three', 'ch_player_two']);
    await env.db.updateTable('privacy_settings').set({ show_country: false }).where('user_id', '=', p1.userId).execute();
    const eg = (await call('GET', `/v1/challenges/${slug}/leaderboard?scope=EG`)).body.entries;
    expect(eg.map((e: Json) => [e.player.handle, e.rank])).toEqual([['ch_player_three', 1], ['ch_player_two', 2]]);
    expect((await call('GET', `/v1/challenges/${slug}/leaderboard`)).body.entries[0]).toMatchObject({ player: { handle: 'ch_player_one' }, country: null });
    await env.db.updateTable('privacy_settings').set({ show_country: true }).where('user_id', '=', p1.userId).execute();
    expect((await call('PUT', `/v1/users/${p1.userId}/block`, { token: p2.token })).status).toBe(204);
    expect((await call('GET', `/v1/challenges/${slug}/leaderboard`, { token: p2.token })).body.entries.map((e: Json) => e.player.handle)).not.toContain('ch_player_one');
    expect((await call('GET', `/v1/challenges/${slug}/entries`)).body.items).toHaveLength(4);
  });

  it('counts votes fairly: no self-votes, three per challenge even in parallel, young accounts set aside', async () => {
    expect((await call('POST', `/v1/challenge-submissions/${subs.p1}/vote`, { token: p1.token })).body.code).toBe('OWN_ENTRY');
    const young = await newUser('ch-young', 'ch_young', { ageDays: 0 });
    expect((await call('POST', `/v1/challenge-submissions/${subs.p1}/vote`, { token: young.token })).body).toEqual({ counted: false, votesLeft: 2 });
    const voter = await newUser('ch-voter', 'ch_voter');
    const four = [subs.p1, subs.p2a, subs.p2b, subs.p3];
    const r = await Promise.all(four.map((id) => call('POST', `/v1/challenge-submissions/${id}/vote`, { token: voter.token })));
    expect(r.filter((x) => x.status === 200)).toHaveLength(3);
    expect(r.filter((x) => x.status !== 200).map((x) => x.body.code)).toEqual(['VOTES_USED']);
    // Many voters at once, and the same voter many times: one row each.
    const crowd = await Promise.all(Array.from({ length: 6 }, (_, i) => newUser(`ch-crowd-${i}`, `ch_crowd_${i}`)));
    await Promise.all([...crowd, ...crowd].map((u) => call('POST', `/v1/challenge-submissions/${subs.p3}/vote`, { token: u.token })));
    const votes = await env.db.selectFrom('challenge_votes').select('voter_id').where('submission_id', '=', subs.p3!).where('eligible', '=', true).execute();
    expect(new Set(votes.map((v) => v.voter_id)).size).toBe(votes.length);
    expect(votes.length).toBeGreaterThanOrEqual(6);
  });

  it('takes one appeal at a time and lets an admin re-score it', async () => {
    const appeal = await call('POST', `/v1/challenge-submissions/${subs.p2a}/appeal`, { token: p2.token, body: { reason: 'The judges missed two touches near the end.' } });
    expect(appeal.status).toBe(201);
    expect((await call('POST', `/v1/challenge-submissions/${subs.p2a}/appeal`, { token: p2.token, body: { reason: 'Second appeal on the same entry.' } })).body.code).toBe('NOT_APPEALABLE');
    expect((await call('POST', `/v1/challenge-submissions/${subs.p1}/appeal`, { token: p2.token, body: { reason: 'Appealing someone else’s entry.' } })).status).toBe(404);
    expect((await call('POST', `/v1/admin/challenge-appeals/${appeal.body.id}/resolve`, { token: p2.token, body: { decision: 'reject', resolution: 'Not my own appeal to decide.' } })).status).toBe(403);
    const open = await call('GET', '/v1/admin/challenge-appeals', { token: admin.token });
    expect(open.body.items.map((a: Json) => a.id)).toContain(appeal.body.id);
    const resolved = await call('POST', `/v1/admin/challenge-appeals/${appeal.body.id}/resolve`, { token: admin.token, body: { decision: 'uphold', resolution: 'Two touches were missed; re-counted.', rescore: { touches: 14 } } });
    expect(resolved.body).toMatchObject({ status: 'upheld', state: 'approved', score: { value: 14 } });
    const scores = await env.db.selectFrom('challenge_scores').select(['value', 'superseded_at']).where('submission_id', '=', subs.p2a!).orderBy('created_at').execute();
    expect(scores.map((s) => [Number(s.value), s.superseded_at === null])).toEqual([[12, false], [14, true]]);
  });

  it('keeps Scout Picks to verified scouts, three each', async () => {
    expect((await call('POST', `/v1/challenges/${slug}/scout-picks`, { token: p1.token, body: { submissionId: subs.p3 } })).body.code).toBe('SCOUT_VERIFICATION_REQUIRED');
    for (const id of [subs.p3, subs.p2b, subs.p1]) expect((await call('POST', `/v1/challenges/${slug}/scout-picks`, { token: scout.token, body: { submissionId: id } })).status).toBe(204);
    expect((await call('POST', `/v1/challenges/${slug}/scout-picks`, { token: scout.token, body: { submissionId: subs.p2a } })).body.code).toBe('PICKS_USED');
  });

  it('runs a head-to-head between friends', async () => {
    expect((await call('POST', `/v1/challenges/${slug}/head-to-heads`, { token: p1.token, body: { opponentId: p3.userId } })).status).toBe(403);
    await call('PUT', `/v1/users/${p3.userId}/follow`, { token: p1.token });
    await call('PUT', `/v1/users/${p1.userId}/follow`, { token: p3.token });
    const h = await call('POST', `/v1/challenges/${slug}/head-to-heads`, { token: p1.token, body: { opponentId: p3.userId } });
    expect(h.status).toBe(201);
    expect((await call('POST', `/v1/challenges/${slug}/head-to-heads`, { token: p1.token, body: { opponentId: p3.userId } })).body.code).toBe('H2H_EXISTS');
    expect((await call('POST', `/v1/challenge-head-to-heads/${h.body.id}/accept`, { token: p1.token })).status).toBe(404);
    expect((await call('POST', `/v1/challenge-head-to-heads/${h.body.id}/accept`, { token: p3.token })).body).toMatchObject({ status: 'accepted', role: 'opponent' });
  });

  it('publishes results only when judging is done (or forced), with podium, awards and XP', async () => {
    expect((await call('POST', `/v1/admin/challenges/${challengeId}/transition`, { token: admin.token, body: { action: 'complete' } })).body.code).toBe('INVALID_TRANSITION');
    expect((await call('POST', `/v1/admin/challenges/${challengeId}/transition`, { token: admin.token, body: { action: 'close' } })).body.status).toBe('judging');
    expect((await call('POST', `/v1/admin/challenges/${challengeId}/transition`, { token: admin.token, body: { action: 'complete' } })).body.code).toBe('ENTRIES_PENDING');
    expect((await judge(j1, subs.p2c!, { decision: 'disqualify', notes: 'The clip is cut in the middle.' })).body).toEqual({ state: 'disqualified', outcome: 'disqualified' });
    const done = await call('POST', `/v1/admin/challenges/${challengeId}/transition`, { token: admin.token, body: { action: 'complete' } });
    expect(done.body.status).toBe('completed');

    const results = (await call('GET', `/v1/challenges/${slug}/results`)).body;
    expect(results).toMatchObject({ published: true, participants: 3 });
    expect(results.podium.map((e: Json) => [e.rank, e.player.handle])).toEqual([[1, 'ch_player_one'], [2, 'ch_player_three'], [3, 'ch_player_two']]);
    expect(results.communityFavorite.player.handle).toBe('ch_player_three');
    expect(results.scoutPicks.map((e: Json) => e.player.handle).sort()).toEqual(['ch_player_one', 'ch_player_three', 'ch_player_two']);
    expect((await call('GET', `/v1/challenges/${slug}/leaderboard`)).body.kind).toBe('final');

    const xp = await env.db.selectFrom('play_xp').select(['source', 'xp']).where('user_id', '=', p1.userId).orderBy('source').execute();
    expect(xp).toEqual([{ source: 'challenge_award', xp: 60 }, { source: 'challenge_entry', xp: 40 }, { source: 'challenge_podium', xp: 150 }]);
    const mine = (await call('GET', '/v1/me/challenges', { token: p1.token })).body;
    expect(mine.badges.map((b: Json) => b.key).sort()).toEqual(['first_entry', 'podium', 'scout_pick', 'winner']);
    expect(mine).toMatchObject({ challengeXp: 250, streakWeeks: 1, personalBests: [{ templateKey: 'juggling_king', value: 40 }] });
    expect(mine.headToHeads[0]).toMatchObject({ status: 'completed', result: 'won' });
    // Running it again awards nothing twice.
    expect((await call('POST', `/v1/admin/challenges/${challengeId}/transition`, { token: admin.token, body: { action: 'complete' } })).body.code).toBe('INVALID_TRANSITION');
    expect((await call('POST', `/v1/challenge-submissions/${subs.p1}/withdraw`, { token: p1.token })).body.code).toBe('RESULTS_PUBLISHED');
    expect((await call('POST', `/v1/challenge-submissions/${subs.p1}/vote`, { token: scout.token })).body.code).toBe('VOTING_CLOSED');
  });

  it('keeps admin tools to admins and reports real metrics', async () => {
    expect((await call('GET', '/v1/admin/challenges', { token: p1.token })).status).toBe(403);
    expect((await call('GET', '/v1/admin/challenges/metrics', { token: p1.token })).status).toBe(403);
    const m = (await call('GET', '/v1/admin/challenges/metrics', { token: admin.token })).body;
    const row = m.challenges.find((c: Json) => c.challenge.slug === slug);
    expect(row).toMatchObject({ participants: 3, approved: 4, disqualified: 1, appeals: 1, scoutPicks: 3, completionRate: 1 });
    expect(m.agents.map((a: Json) => a.agent)).toEqual(expect.arrayContaining(['verification', 'scoring', 'operations']));
    expect(m.agents.find((a: Json) => a.agent === 'scoring').costUsd).toBe(0);
    const fraud = await call('GET', `/v1/admin/challenges/${challengeId}/fraud`, { token: admin.token });
    expect(fraud.body.setAsideVotes).toEqual([{ submissionId: subs.p1, count: 1, reason: 'new_account' }]);
    const audit = await env.db.selectFrom('audit_logs').select('action').where('action', 'like', 'challenge.%').execute();
    expect([...new Set(audit.map((a) => a.action))].sort()).toEqual(expect.arrayContaining(['challenge.created', 'challenge.status_changed', 'challenge.results_published', 'challenge.appeal_upheld', 'challenge.judges_set']));
  });

  it('lists indexable challenges in the sitemap and keeps drafts and templates out', async () => {
    const map = (await call('GET', '/v1/sitemap')).body;
    expect(map.challenges.map((c: Json) => c.slug)).toContain(slug);
    expect(map.challenges.some((c: Json) => c.slug.startsWith('tpl-'))).toBe(false);
    expect((await call('GET', `/v1/seo/challenges/${slug}`)).body).toMatchObject({ slug, phase: 'completed' });
    expect((await call('GET', '/v1/seo/challenges/tpl-juggling-king')).status).toBe(404);
  });

  it('exports challenge data and removes it with the account', async () => {
    const exp = (await call('GET', '/v1/me/export', { token: p3.token })).body;
    expect(exp.challenges.submissions).toHaveLength(2);
    expect(exp.challenges.badges.map((b: Json) => b.badge)).toContain('community_favorite');
    expect((await call('DELETE', '/v1/me', { token: p3.token, body: { confirm: 'DELETE' } })).body.status).toBe('deleted');
    const results = (await call('GET', `/v1/challenges/${slug}/results`)).body;
    expect(results.podium.map((e: Json) => e.player.handle)).not.toContain('ch_player_three');
    expect(results.communityFavorite).toBeNull();
    expect((await call('GET', `/v1/challenges/${slug}/leaderboard`)).body.entries.map((e: Json) => e.player.handle)).toEqual(['ch_player_one', 'ch_player_two']);
    const left = await env.db.selectFrom('challenge_votes').select('voter_id').where('voter_id', '=', p3.userId).execute();
    expect(left).toEqual([]);
  });
});

describe('KICKSCOUT Challenges: safety and eligibility', () => {
  let admin: User;
  let judgeUser: User;
  let adultPlayer: User;
  let minorPlayer: User;
  const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  beforeAll(async () => {
    admin = await newUser('sf-admin', 'sf_admin', { roles: ['admin'], mfa: true });
    judgeUser = await newUser('sf-judge', 'sf_judge', { mfa: true });
    adultPlayer = await newUser('sf-adult', 'sf_adult');
    const token = await env.token('sf-minor');
    const res = await call('POST', '/v1/onboarding/register', { token, body: { handle: 'sf_minor', displayName: 'sf_minor', dob: '2011-03-15', countryCode: 'EG', roles: ['player'] } });
    expect(res.status).toBe(201);
    // Guardian approval is tested elsewhere; here the minor is active but has no public-profile consent.
    await env.db.updateTable('users').set({ status: 'active' }).where('id', '=', res.body.userId).execute();
    minorPlayer = { token, userId: res.body.userId, handle: 'sf_minor' };
  });

  async function challenge(slug: string, extra: Json) {
    const body = { slug, title: { en: slug, ar: slug }, description: { en: 'A test challenge.', ar: 'تحدٍ تجريبي.' }, startsAt: at(-1), endsAt: at(48), ...extra };
    const c = await call('POST', '/v1/admin/challenges', { token: admin.token, body });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect((await call('POST', `/v1/admin/challenges/${c.body.id}/transition`, { token: admin.token, body: { action: 'publish' } })).body.status).toBe('active');
    return c.body.id as string;
  }

  it('asks for safety acknowledgement and consent of others before an advanced partner skill', async () => {
    await challenge('panna-duel', { difficulty: 'advanced', requiresPartner: true, safetyNotes: { en: 'Play gently; no slide tackles.', ar: 'العب بلطف.' }, ageGroups: ['adult'] });
    const page = (await call('GET', '/v1/challenges/panna-duel', { token: adultPlayer.token })).body;
    expect(page).toMatchObject({ needsSafetyAck: true, requiresPartner: true, me: { eligibility: { allowed: false, code: 'SAFETY_ACK_REQUIRED' } } });
    expect((await call('POST', '/v1/challenges/panna-duel/submissions', { token: adultPlayer.token, body: clip() })).body.code).toBe('CONSENT_OTHERS_REQUIRED');
    expect((await call('POST', '/v1/challenges/panna-duel/submissions', { token: adultPlayer.token, body: clip({ consentOthers: true }) })).body.code).toBe('SAFETY_ACK_REQUIRED');
    expect((await call('POST', '/v1/challenges/panna-duel/submissions', { token: adultPlayer.token, body: clip({ consentOthers: true, safetyAck: true }) })).status).toBe(201);
    // The acknowledgement is remembered for the next attempt.
    expect((await call('POST', '/v1/challenges/panna-duel/submissions', { token: adultPlayer.token, body: clip({ consentOthers: true }) })).status).toBe(201);
    expect((await call('POST', '/v1/challenges/panna-duel/submissions', { token: minorPlayer.token, body: clip({ consentOthers: true, safetyAck: true }) })).body.code).toBe('AGE_GROUP_NOT_ELIGIBLE');
  });

  it('withdraws an entry, freeing the attempt', async () => {
    await challenge('withdraw-test', { attemptLimit: 1 });
    const e = await call('POST', '/v1/challenges/withdraw-test/submissions', { token: adultPlayer.token, body: clip() });
    expect((await call('POST', '/v1/challenges/withdraw-test/submissions', { token: adultPlayer.token, body: clip() })).body.code).toBe('ATTEMPTS_USED');
    expect((await call('POST', `/v1/challenge-submissions/${e.body.submissionId}/withdraw`, { token: judgeUser.token })).status).toBe(404);
    expect((await call('POST', `/v1/challenge-submissions/${e.body.submissionId}/withdraw`, { token: adultPlayer.token })).status).toBe(204);
    expect((await call('POST', '/v1/challenges/withdraw-test/submissions', { token: adultPlayer.token, body: clip() })).status).toBe(201);
  });

  it('lets only staff judge a minor’s private clip, and never lists it', async () => {
    const id = await challenge('youth-cup', {});
    expect((await call('PUT', `/v1/admin/challenges/${id}/judges`, { token: admin.token, body: { userIds: [minorPlayer.userId] } })).body.code).toBe('INVALID_JUDGES');
    await call('PUT', `/v1/admin/challenges/${id}/judges`, { token: admin.token, body: { userIds: [judgeUser.userId] } });
    const e = await enter(minorPlayer, 'youth-cup');
    const video = await env.db.selectFrom('videos').select('visibility').where('id', '=', e.videoId).executeTakeFirstOrThrow();
    expect(video.visibility).toBe('private');
    expect((await call('GET', '/v1/judge/challenges/queue', { token: judgeUser.token })).body.items).toEqual([]);
    expect((await judge(judgeUser, e.submissionId, { decision: 'score', components: { execution: 9, control: 9, difficulty: 9 } })).status).toBe(403);
    expect((await judge(admin, e.submissionId, { decision: 'score', components: { execution: 9, control: 9, difficulty: 9 } })).body.outcome).toBe('approved');
    expect((await call('GET', '/v1/challenges/youth-cup/leaderboard')).body.entries).toEqual([]);
    expect((await call('GET', '/v1/challenges/youth-cup/entries')).body.items).toEqual([]);
    const mine = (await call('GET', '/v1/challenges/youth-cup', { token: minorPlayer.token })).body.me.submissions[0];
    expect(mine).toMatchObject({ state: 'approved', score: { value: 90 }, rank: null });
  });
});
