import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureProvider, ProviderError, type FootballProvider } from '@fp/football';
import { createTestEnv, type TestEnv } from './helpers.js';
import type { PushMessage, PushResult, PushSender, PushTarget } from '../src/platform/push.js';
import { loadConfig } from '../src/config.js';

type Json = Record<string, any>;

/** Records what would be sent; endpoints containing "gone" answer like an expired subscription. */
class FakePush implements PushSender {
  readonly publicKey = 'B'.repeat(87);
  readonly sent: { endpoint: string; message: PushMessage }[] = [];
  async send(t: PushTarget, message: PushMessage): Promise<PushResult> {
    if (t.endpoint.includes('gone')) return { ok: false, gone: true, error: 'push service answered 410' };
    if (t.endpoint.includes('flaky')) return { ok: false, gone: false, error: 'push service answered 500' };
    this.sent.push({ endpoint: t.endpoint, message });
    return { ok: true };
  }
}

const T0 = new Date('2026-10-25T15:00:00Z');
let clock = T0;
const advance = (seconds: number) => { clock = new Date(clock.getTime() + seconds * 1000); };

let env: TestEnv;
let fixture: FixtureProvider;
const push = new FakePush();

beforeAll(async () => {
  fixture = new FixtureProvider(() => clock);
  env = await createTestEnv({}, { football: fixture, push });
  env.deps.now = () => clock;
});
afterAll(async () => {
  await env?.close();
});

async function call(method: string, url: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await env.app.inject({ method: method as 'GET', url, headers, ...(opts.body !== undefined ? { payload: opts.body as Json } : {}) });
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Json };
}

async function newUser(sub: string, handle: string) {
  const token = await env.token(sub);
  const res = await call('POST', '/v1/onboarding/register', { token, body: { handle, displayName: handle, dob: '1995-04-02', countryCode: 'EG', roles: ['fan'] } });
  expect(res.status).toBe(201);
  return { token, userId: res.body.userId as string };
}

const fcm = (name: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) }, locale: 'en' });
const cron = () => call('GET', '/v1/cron/football', { headers: { authorization: 'Bearer cron-secret-for-tests-0123456789' } });

describe('public scores (no account)', () => {
  it('lists a day of matches with provenance, test-data label and normalised states', async () => {
    const r = await call('GET', '/v1/football/matches?date=2026-10-25&tz=Africa/Cairo');
    expect(r.status).toBe(200);
    expect(r.body.source).toMatchObject({ provider: 'fixture', testData: true, stale: false, attribution: null });
    expect(r.body.source.fetchedAt).toBe(T0.toISOString());
    expect(r.body).toMatchObject({ day: '2026-10-25', timeZone: 'Africa/Cairo', coverage: 'day' });
    expect(r.body.matches.map((m: Json) => m.status)).toEqual(['finished', 'halftime', 'live', 'scheduled', 'postponed', 'scheduled']);
    expect(r.body.competitions.map((c: Json) => c.id)).toEqual(['TCUP', 'TL1']);
  });
  it('filters by state and competition, and rejects bad dates and zones', async () => {
    const live = await call('GET', '/v1/football/matches?date=2026-10-25&status=live');
    expect(live.body.matches.map((m: Json) => m.id).sort()).toEqual(['fx-2', 'fx-3']);
    const cup = await call('GET', '/v1/football/matches?date=2026-10-25&competition=TCUP&status=upcoming');
    expect(cup.body.matches.map((m: Json) => m.id)).toEqual(['fx-5']);
    expect((await call('GET', '/v1/football/matches?tz=Mars/Base')).body.code).toBe('INVALID_TIME_ZONE');
    expect((await call('GET', '/v1/football/matches?date=2026-02-30')).body.code).toBe('INVALID_DATE');
  });
  it('shares one provider call between visitors while the data is fresh', async () => {
    const before = fixture.calls;
    await call('GET', '/v1/football/matches?date=2026-10-25');
    await call('GET', '/v1/football/matches?date=2026-10-25');
    expect(fixture.calls).toBe(before);
  });
  it('serves match pages, team fixtures, standings and search', async () => {
    const m = await call('GET', '/v1/football/matches/fx-2');
    expect(m.status).toBe(200);
    expect(m.body.match).toMatchObject({ id: 'fx-2', status: 'live', minute: 30, home: { name: 'North Park United' } });
    expect(m.body.match.events).toHaveLength(1);
    expect((await call('GET', '/v1/football/matches/nope')).status).toBe(404);
    expect((await call('GET', '/v1/football/matches/%3Cscript%3E')).status).toBe(404);
    const team = await call('GET', '/v1/football/teams/t-river');
    expect(team.body.team.name).toBe('River Test FC');
    const table = await call('GET', '/v1/football/competitions/TL1/standings');
    expect(table.body.groups[0].rows).toHaveLength(6);
    const s = await call('GET', '/v1/football/search?q=harb');
    expect(s.body.teams.map((t: Json) => t.id)).toEqual(['t-harbour']);
    expect((await call('GET', '/v1/football/search?q=%25')).status).toBe(400);
    const status = await call('GET', '/v1/football/status');
    expect(status.body).toMatchObject({ enabled: true, push: { available: true }, health: { consecutiveFailures: 0 } });
  });
});

describe('provider failures', () => {
  it('answer 503 with no data, serve the last good copy marked stale after that, and back off', async () => {
    let fail = true;
    let calls = 0;
    const inner = new FixtureProvider(() => clock);
    const flaky: FootballProvider = {
      info: inner.info,
      async matches(a, b) { calls++; if (fail) throw new ProviderError('unavailable', 'down'); return inner.matches(a, b); },
      match: (id) => inner.match(id), teamMatches: (id) => inner.teamMatches(id), standings: (id) => inner.standings(id), competitions: () => inner.competitions(),
    };
    const e2 = await createTestEnv({}, { football: flaky });
    e2.deps.now = () => clock;
    try {
      const get = async () => { const r = await e2.app.inject({ method: 'GET', url: '/v1/football/matches?date=2026-10-25' }); return { status: r.statusCode, body: r.json() as Json }; };
      expect(await get()).toMatchObject({ status: 503, body: { code: 'FOOTBALL_PROVIDER_UNAVAILABLE' } });
      expect(await get()).toMatchObject({ status: 503 });
      expect(calls).toBe(1); // backing off: the second request did not call the provider
      const home = await e2.app.inject({ method: 'GET', url: '/v1/health' });
      expect(home.statusCode).toBe(200); // the rest of the API is unaffected

      fail = false;
      const realNow = clock;
      e2.deps.now = () => new Date(realNow.getTime() + 20_000);
      expect((await get()).body.source.stale).toBe(false);
      fail = true;
      e2.deps.now = () => new Date(realNow.getTime() + 20 * 60_000);
      const stale = await get();
      expect(stale.status).toBe(200);
      expect(stale.body.source).toMatchObject({ stale: true, fetchedAt: new Date(realNow.getTime() + 20_000).toISOString() });
      const health = await e2.app.inject({ method: 'GET', url: '/v1/football/status' });
      expect((health.json() as Json).health).toMatchObject({ consecutiveFailures: 1, lastErrorKind: 'unavailable' });
    } finally {
      await e2.close();
    }
  });
  it('turns off cleanly and refuses invented data in production', async () => {
    const off = await createTestEnv({}, { football: null });
    try {
      const r = await off.app.inject({ method: 'GET', url: '/v1/football/matches' });
      expect(r.statusCode).toBe(503);
      expect((r.json() as Json).code).toBe('FOOTBALL_DISABLED');
    } finally {
      await off.close();
    }
    const base = {
      DATABASE_URL: 'postgres://x', AUTH_JWKS_URL: 'https://a.test/jwks', AUTH_ISSUER: 'x', AUTH_AUDIENCE: 'x', S3_BUCKET_ORIGINALS: 'b', CDN_BASE_URL: 'https://cdn.test',
      DOB_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), VIEWER_HASH_SECRET: 'x'.repeat(32),
    };
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', MAILER: 'log', ALLOW_LOG_MAILER: 'yes', FOOTBALL_PROVIDER: 'fixture' })).toThrow(/invented test data/);
    expect(() => loadConfig({ ...base, FOOTBALL_PROVIDER: 'football-data' })).toThrow(/FOOTBALL_DATA_API_KEY/);
    expect(() => loadConfig({ ...base, VAPID_PUBLIC_KEY: 'B'.repeat(87) })).toThrow(/together/);
    expect(loadConfig(base).FOOTBALL_PROVIDER).toBe('sportscore');
  });
});

describe('favourites', () => {
  it('need an account, save, merge duplicates, and restore in a new session', async () => {
    expect((await call('GET', '/v1/me/football/favorites')).status).toBe(401);
    const a = await newUser('fav-a', 'fav_a');
    await call('GET', '/v1/football/matches?date=2026-10-25'); // fills the team directory
    expect((await call('PUT', '/v1/me/football/favorites/teams/t-river', { token: a.token })).status).toBe(200);
    expect((await call('PUT', '/v1/me/football/favorites/teams/t-river', { token: a.token })).status).toBe(200);
    const after = await call('PUT', '/v1/me/football/favorites/competitions/TL1', { token: a.token });
    expect(after.body.teams.map((t: Json) => t.id)).toEqual(['t-river']);
    expect(after.body.competitions.map((c: Json) => c.id)).toEqual(['TL1']);
    expect((await call('PUT', '/v1/me/football/favorites/teams/not-a-team', { token: a.token })).status).toBe(404);
    // A fresh token (another device) sees the same list.
    const again = await call('GET', '/v1/me/football/favorites', { token: await env.token('fav-a') });
    expect(again.body.teams.map((t: Json) => t.name)).toEqual(['River Test FC']);
  });
  it('belong to their owner only', async () => {
    const a = await newUser('fav-own-a', 'fav_own_a');
    const b = await newUser('fav-own-b', 'fav_own_b');
    await call('PUT', '/v1/me/football/favorites/teams/t-city', { token: a.token });
    await call('DELETE', '/v1/me/football/favorites/teams/t-city', { token: b.token });
    expect((await call('GET', '/v1/me/football/favorites', { token: a.token })).body.teams.map((t: Json) => t.id)).toEqual(['t-city']);
    expect((await call('GET', '/v1/me/football/favorites', { token: b.token })).body.teams).toEqual([]);
  });
  it('import picks made before sign-up, ignoring unknown ids, and cap at 50', async () => {
    const u = await newUser('fav-imp', 'fav_imp');
    const r = await call('POST', '/v1/me/football/favorites/import', { token: u.token, body: { teams: ['t-dunes', 'zzz', 't-dunes'], competitions: ['TCUP'] } });
    expect(r.body.teams.map((t: Json) => t.id)).toEqual(['t-dunes']);
    expect(r.body.competitions.map((c: Json) => c.id)).toEqual(['TCUP']);
    const many = Array.from({ length: 60 }, (_, i) => ({ provider: 'fixture', id: `bulk-${i}`, name: `Bulk ${i}` }));
    await env.db.insertInto('football_teams').values(many).execute();
    await call('POST', '/v1/me/football/favorites/import', { token: u.token, body: { teams: many.map((m) => m.id).slice(0, 50) } });
    expect((await call('GET', '/v1/me/football/favorites', { token: u.token })).body.teams).toHaveLength(50);
    expect((await call('PUT', '/v1/me/football/favorites/teams/bulk-55', { token: u.token })).body.code).toBe('FAVORITES_LIMIT');
  });
});

describe('push subscriptions', () => {
  it('are stored only for allowed push services and can be removed', async () => {
    const u = await newUser('push-a', 'push_a');
    expect((await call('GET', '/v1/push/config')).body).toEqual({ available: true, publicKey: push.publicKey });
    expect((await call('POST', '/v1/me/push/subscriptions', { body: fcm('x') })).status).toBe(401);
    const bad = await call('POST', '/v1/me/push/subscriptions', { token: u.token, body: { ...fcm('x'), endpoint: 'https://169.254.169.254/latest' } });
    expect(bad.body.code).toBe('PUSH_ENDPOINT_NOT_ALLOWED');
    expect((await call('POST', '/v1/me/push/subscriptions', { token: u.token, body: { ...fcm('x'), endpoint: 'http://fcm.googleapis.com/x' } })).status).toBe(400);
    expect((await call('POST', '/v1/me/push/subscriptions', { token: u.token, body: fcm('push-a-1') })).body).toEqual({ registered: true, devices: 1 });
    expect((await call('POST', '/v1/me/push/status', { token: u.token, body: { endpoint: fcm('push-a-1').endpoint } })).body.registered).toBe(true);
    // The same browser signed in as someone else now belongs to them.
    const b = await newUser('push-b', 'push_b');
    await call('POST', '/v1/me/push/subscriptions', { token: b.token, body: fcm('push-a-1') });
    expect((await call('POST', '/v1/me/push/status', { token: u.token, body: { endpoint: fcm('push-a-1').endpoint } })).body).toEqual({ registered: false, devices: 0 });
    expect((await call('POST', '/v1/me/push/subscriptions/remove', { token: b.token, body: { endpoint: fcm('push-a-1').endpoint } })).body.devices).toBe(0);
  });
  it('send a test notification and drop expired endpoints', async () => {
    const u = await newUser('push-test', 'push_test');
    expect((await call('POST', '/v1/me/push/test', { token: u.token })).body.code).toBe('NO_PUSH_DEVICES');
    await call('POST', '/v1/me/push/subscriptions', { token: u.token, body: fcm('push-test-ok') });
    await call('POST', '/v1/me/push/subscriptions', { token: u.token, body: fcm('push-test-gone') });
    expect((await call('POST', '/v1/me/push/test', { token: u.token })).body).toEqual({ sent: 1, failed: 0, removed: 1 });
    expect(push.sent.at(-1)).toMatchObject({ endpoint: fcm('push-test-ok').endpoint, message: { title: 'KICKSCOUT test notification', url: '/following' } });
  });
});

describe('match alerts', () => {
  it('need the cron secret', async () => {
    expect((await call('GET', '/v1/cron/football')).status).toBe(401);
  });

  it('follow real state changes once each, honour categories and drop dead devices', async () => {
    clock = T0;
    const fan = await newUser('alert-fan', 'alert_fan');
    const quiet = await newUser('alert-quiet', 'alert_quiet');
    const noGoals = await newUser('alert-nogoals', 'alert_nogoals');
    for (const u of [fan, quiet, noGoals]) {
      await call('PUT', '/v1/me/football/favorites/teams/t-harbour', { token: u.token });
      await call('POST', '/v1/me/push/subscriptions', { token: u.token, body: fcm(`dev-${u.userId}`) });
    }
    await call('POST', '/v1/me/push/subscriptions', { token: fan.token, body: fcm('dev-fan-gone') });
    const prefs = await call('PATCH', '/v1/me/football/alerts', { token: fan.token, body: { enabled: true, categories: { starting_soon: true } } });
    expect(prefs.body).toMatchObject({ enabled: true, categories: { starting_soon: true, kickoff: true, goal: true, halftime: false, final_result: true, lineups: false }, unsupported: [] });
    await call('PATCH', '/v1/me/football/alerts', { token: noGoals.token, body: { enabled: true, categories: { goal: false } } });
    // `quiet` follows the team and has a device but never turned alerts on.

    const fanDev = fcm(`dev-${fan.userId}`).endpoint;
    const toFan = () => push.sent.filter((s) => s.endpoint === fanDev).map((s) => s.message.title);
    const toNoGoals = () => push.sent.filter((s) => s.endpoint === fcm(`dev-${noGoals.userId}`).endpoint).map((s) => s.message.title);
    const toQuiet = () => push.sent.filter((s) => s.endpoint === fcm(`dev-${quiet.userId}`).endpoint);

    // fx-4 Harbour Athletic v North Park United kicks off in 20 minutes.
    const first = await cron();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ran: true, removed: 1 });
    expect(toFan()).toEqual(['Starting soon']);
    expect(await env.db.selectFrom('push_subscriptions').select('id').where('endpoint', '=', fcm('dev-fan-gone').endpoint).execute()).toEqual([]);
    // fx-1 (Harbour lost earlier, already finished) was seen for the first time: no "full-time" from a first sighting.
    expect(toFan()).not.toContain('Full-time');

    await cron();
    expect(toFan()).toEqual(['Starting soon']); // same run again: nothing new

    advance(70);
    fixture.set('fx-4', { status: 'live', score: { home: 0, away: 0 } });
    await cron();
    advance(70);
    fixture.set('fx-4', { status: 'live', score: { home: 1, away: 0 } });
    await cron();
    await cron();
    advance(70);
    fixture.set('fx-4', { status: 'halftime', score: { home: 1, away: 0 } });
    await cron();
    advance(70);
    fixture.set('fx-4', { status: 'finished', score: { home: 1, away: 0 } });
    await cron();

    expect(toFan()).toEqual(['Starting soon', 'Kick-off', 'Goal!', 'Full-time']);
    expect(push.sent.find((s) => s.endpoint === fanDev && s.message.title === 'Goal!')?.message).toEqual({
      title: 'Goal!', body: 'Harbour Athletic 1–0 North Park United', url: '/scores/match/fx-4', tag: 'mfx4',
    });
    expect(toNoGoals()).toEqual(['Kick-off', 'Full-time']);
    expect(toQuiet()).toEqual([]);
  });

  it('report why nothing ran when push is not configured', async () => {
    const e2 = await createTestEnv({}, { push: null });
    try {
      const r = await e2.app.inject({ method: 'GET', url: '/v1/cron/football', headers: { authorization: 'Bearer cron-secret-for-tests-0123456789' } });
      expect((r.json() as Json)).toMatchObject({ ran: false, skippedReason: 'Web Push is not configured (VAPID keys missing)' });
    } finally {
      await e2.close();
    }
  });
});

describe('account data', () => {
  it('exports favourites and alert settings without device endpoints, and deletion erases them', async () => {
    const u = await newUser('fav-del', 'fav_del');
    await call('PUT', '/v1/me/football/favorites/teams/t-valley', { token: u.token });
    await call('POST', '/v1/me/push/subscriptions', { token: u.token, body: fcm('fav-del-dev') });
    const ex = await call('GET', '/v1/me/export', { token: u.token });
    expect(ex.body.football).toMatchObject({ teams: [{ id: 't-valley', name: 'Valley Rovers' }], alerts: { enabled: false } });
    expect(JSON.stringify(ex.body)).not.toContain('fav-del-dev');
    expect((await call('DELETE', '/v1/me', { token: u.token, body: { confirm: 'DELETE' } })).body.status).toBe('deleted');
    expect(await env.db.selectFrom('favorite_teams').select('team_id').where('user_id', '=', u.userId).execute()).toEqual([]);
    expect(await env.db.selectFrom('push_subscriptions').select('id').where('user_id', '=', u.userId).execute()).toEqual([]);
  });
});
