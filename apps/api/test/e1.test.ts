import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import Fastify from 'fastify';
import { createDb } from '@fp/db';
import { rollupAnalytics } from '@fp/worker/analytics';
import { buildApp } from '../src/app.js';
import { problemHandler } from '../src/platform/errors.js';
import type { ErrorContext, ErrorReporter } from '../src/platform/error-reporter.js';
import { invalidateFlags, isEnabled } from '../src/platform/flags.js';
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

async function call(method: string, url: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await env.app.inject({ method: method as 'GET', url, headers, ...(opts.body !== undefined ? { payload: opts.body as Json } : {}) });
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Json, headers: res.headers };
}

const adult = (handle: string, roles = ['player'], country = 'EG') => ({ handle, displayName: handle, dob: '1995-04-02', countryCode: country, roles });

async function newUser(sub: string, handle: string, roles = ['player'], country = 'EG'): Promise<User> {
  const token = await env.token(sub);
  const res = await call('POST', '/v1/onboarding/register', { token, body: adult(handle, roles, country) });
  expect(res.status).toBe(201);
  return { token, userId: res.body.userId };
}
async function staff(sub: string, handle: string, role: 'admin' | 'moderator', mfa = true): Promise<User> {
  const u = await newUser(sub, handle, ['fan']);
  await env.db.insertInto('user_roles').values({ user_id: u.userId, role }).execute();
  return { userId: u.userId, token: await env.token(sub, mfa ? { amr: [{ method: 'totp' }], aal: 'aal2' } : {}) };
}
async function scout(sub: string, handle: string): Promise<User> {
  const u = await newUser(sub, handle, ['fan']);
  await env.db.insertInto('user_roles').values({ user_id: u.userId, role: 'scout' }).execute();
  return u;
}
const eventsOf = (userId: string) => env.db.selectFrom('analytics_events').selectAll().where('user_id', '=', userId).orderBy('id').execute();

/** A published, public clip owned by `ownerId`, written straight to the database (the worker is tested elsewhere). */
async function clip(ownerId: string, extra: Json = {}) {
  const id = randomUUID();
  await env.db.insertInto('videos').values({
    id, owner_user_id: ownerId, status: 'published', original_key: `originals/${ownerId}/${id}.mp4`, declared_type: 'video/mp4', size_bytes: 1000,
    title: 'Clip', visibility: 'public', playback_key: `playback/${id}.mp4`, thumbnail_key: `thumbs/${id}.jpg`, published_at: new Date(), moderation: 'safe', ...extra,
  }).execute();
  return id;
}

// ------------------------------------------------------------------------------------ analytics
describe('analytics events', () => {
  it('records server events at key points with registry-shaped properties', async () => {
    const p = await newUser('an-player', 'an_player');
    const fan = await newUser('an-fan', 'an_fan', ['fan']);
    const signup = (await eventsOf(p.userId))[0]!;
    expect(signup).toMatchObject({ name: 'signup_completed', source: 'server', anon_id: null });
    expect(signup.properties).toEqual({ roles: ['player'], scoutApplication: false, locale: 'en', country: 'EG' });

    const v = await clip(p.userId);
    expect((await call('PUT', `/v1/videos/${v}/like`, { token: fan.token })).status).toBe(204);
    expect((await call('PUT', `/v1/videos/${v}/like`, { token: fan.token })).status).toBe(204); // repeat: not a new like
    expect((await call('PUT', `/v1/videos/${v}/save`, { token: fan.token })).status).toBe(204);
    expect((await call('PUT', `/v1/users/${p.userId}/follow`, { token: fan.token })).status).toBe(204);
    expect((await call('POST', `/v1/videos/${v}/view`, { token: fan.token })).status).toBe(204);
    expect((await call('GET', '/v1/profiles/an_player', { token: fan.token })).status).toBe(200);
    const names = (await eventsOf(fan.userId)).map((e) => [e.name, e.properties]);
    expect(names).toEqual([
      ['signup_completed', { roles: ['fan'], scoutApplication: false, locale: 'en', country: 'EG' }],
      ['video_liked', { videoId: v }],
      ['video_saved', { videoId: v }],
      ['follow', { followeeId: p.userId }],
      ['video_viewed', { videoId: v }],
      ['profile_viewed', { profileId: p.userId, self: false }],
    ]);
  });

  it('counts signed-out views by a daily hashed id, never a raw IP', async () => {
    const p = await newUser('an-anon-owner', 'an_anon_owner');
    const v = await clip(p.userId);
    expect((await call('POST', `/v1/videos/${v}/view`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(204);
    const row = await env.db.selectFrom('analytics_events').selectAll().where('name', '=', 'video_viewed').where('user_id', 'is', null).orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(row.anon_id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain('203.0.113.9');
  });

  it('records scout search (filter names only), shortlist adds, pipeline moves and contact requests', async () => {
    const s = await scout('an-scout', 'an_scout');
    const p = await newUser('an-target', 'an_target');
    await env.db.insertInto('consents').values({ id: randomUUID(), subject_user_id: p.userId, granted_by: p.userId, purpose: 'scout_contact', granted: true, policy_version: 't' }).execute();
    expect((await call('GET', '/v1/scout/players?position=LW&q=secret+name', { token: s.token })).status).toBe(200);
    const list = await call('POST', '/v1/scout/shortlists', { token: s.token, body: { name: 'Wingers' } });
    expect((await call('PUT', `/v1/scout/shortlists/${list.body.id}/players/${p.userId}`, { token: s.token })).status).toBe(204);
    const card = await call('PUT', `/v1/scout/crm/players/${p.userId}`, { token: s.token, body: { stage: 'watching' } });
    expect(card.status).toBe(200);
    const moved = await call('POST', `/v1/scout/crm/entries/${card.body.id}/stage`, { token: s.token, body: { stage: 'contact_requested', message: 'We would like to talk.' } });
    expect(moved.status).toBe(200);

    const events = (await eventsOf(s.userId)).map((e) => [e.name, e.properties as Json]).filter(([n]) => n !== 'signup_completed');
    expect(events[0]).toEqual(['scout_search', { filters: ['q', 'position'], results: expect.any(Number), firstPage: true }]);
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(events.slice(1).map(([n]) => n)).toEqual(['shortlist_add', 'crm_stage_changed', 'crm_stage_changed', 'contact_requested']);
    expect(events[3]![1]).toMatchObject({ from: 'watching', to: 'contact_requested', scope: 'personal' });
    expect(events[4]![1]).toMatchObject({ playerId: p.userId, origin: 'pipeline' });
  });

  it('honours the analytics preference: opted-out people get only strictly necessary events', async () => {
    const p = await newUser('an-optout', 'an_optout');
    const owner = await newUser('an-optout-owner', 'an_optout_owner');
    const v = await clip(owner.userId);
    const patched = await call('PATCH', `/v1/users/${p.userId}/privacy`, { token: p.token, body: { allowAnalytics: false } });
    expect(patched.status).toBe(200);
    expect(patched.body.allowAnalytics).toBe(false);
    await call('PUT', `/v1/videos/${v}/like`, { token: p.token });
    const batch = await call('POST', '/v1/events', { token: p.token, body: { events: [{ name: 'page_viewed', properties: { path: '/discover' } }] } });
    expect(batch.body).toEqual({ accepted: 0, dropped: 1 });
    expect((await eventsOf(p.userId)).map((e) => e.name)).toEqual(['signup_completed']);
  });

  it('only a guardian can turn a minor’s analytics back on', async () => {
    const token = await env.token('an-minor');
    const res = await call('POST', '/v1/onboarding/register', { token, body: { handle: 'an_minor', displayName: 'Kid', dob: '2011-03-15', countryCode: 'EG', roles: ['player'] } });
    const kid = res.body.userId as string;
    // The minor's sign-up event keeps ids and coarse facts but drops the country.
    expect((await eventsOf(kid))[0]!.properties).toEqual({ roles: ['player'], scoutApplication: false, locale: 'en' });
    await env.db.updateTable('users').set({ status: 'active' }).where('id', '=', kid).execute();
    expect((await call('PATCH', `/v1/users/${kid}/privacy`, { token, body: { allowAnalytics: false } })).status).toBe(200);
    expect((await call('PATCH', `/v1/users/${kid}/privacy`, { token, body: { allowAnalytics: true } })).body.code).toBe('GUARDIAN_REQUIRED');
  });

  it('accepts only allowlisted client events with valid properties, in batches of at most 20', async () => {
    const u = await newUser('an-client', 'an_client');
    const r = await call('POST', '/v1/events', {
      token: u.token,
      body: {
        events: [
          { name: 'page_viewed', properties: { path: '/u/[handle]' } },
          { name: 'cta_clicked', properties: { cta: 'show_your_skill', path: '/' } },
          { name: 'page_viewed', properties: { path: '/search?q=ahmed' } }, // query strings are refused
          { name: 'subscription_activated', properties: { planKey: 'scout_pro', status: 'active' } }, // server-only
          { name: 'drop_table', properties: {} }, // unknown
          { name: 'share_clicked', properties: { videoId: randomUUID(), email: 'a@b.c' } }, // extra property
        ],
      },
    });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ accepted: 2, dropped: 4 });
    const client = (await eventsOf(u.userId)).filter((e) => e.source === 'client');
    expect(client.map((e) => e.name)).toEqual(['page_viewed', 'cta_clicked']);

    const tooMany = Array.from({ length: 21 }, () => ({ name: 'page_viewed', properties: { path: '/' } }));
    expect((await call('POST', '/v1/events', { token: u.token, body: { events: tooMany } })).status).toBe(400);
  });

  it('drops a signed-out browser’s events when it sends Global Privacy Control', async () => {
    const body = { events: [{ name: 'page_viewed', properties: { path: '/' } }] };
    expect((await call('POST', '/v1/events', { body, headers: { 'sec-gpc': '1', 'x-forwarded-for': '198.51.100.1' } })).body).toEqual({ accepted: 0, dropped: 1 });
    expect((await call('POST', '/v1/events', { body, headers: { 'x-forwarded-for': '198.51.100.1' } })).body).toEqual({ accepted: 1, dropped: 0 });
  });

  it('rate-limits event ingestion', async () => {
    const u = await newUser('an-rate', 'an_rate');
    const body = { events: [{ name: 'page_viewed', properties: { path: '/' } }] };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await call('POST', '/v1/events', { token: u.token, body })).status);
    expect(statuses.slice(0, 30).every((s) => s === 202)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('erases a person’s raw events when the account is deleted', async () => {
    const u = await newUser('an-delete', 'an_delete');
    expect((await eventsOf(u.userId)).length).toBeGreaterThan(0);
    expect((await call('DELETE', '/v1/me', { token: u.token, body: { confirm: 'DELETE' } })).body.status).toBe('deleted');
    expect(await eventsOf(u.userId)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------ admin metrics
describe('admin metrics', () => {
  it('is for admins with MFA only', async () => {
    const plain = await newUser('m-plain', 'm_plain');
    const mod = await staff('m-mod', 'm_mod', 'moderator');
    const noMfa = await staff('m-nomfa', 'm_nomfa', 'admin', false);
    expect((await call('GET', '/v1/admin/metrics')).status).toBe(401);
    expect((await call('GET', '/v1/admin/metrics', { token: plain.token })).status).toBe(403);
    expect((await call('GET', '/v1/admin/metrics', { token: mod.token })).status).toBe(403);
    expect((await call('GET', '/v1/admin/metrics', { token: noMfa.token })).body.code).toBe('MFA_REQUIRED');
  });

  it('returns the North Star trend, active users and funnels from the rollup', async () => {
    const admin = await staff('m-admin', 'm_admin', 'admin');
    const s = await scout('m-scout', 'm_scout');
    const p = await newUser('m-player', 'm_player');
    const yesterday = new Date(Date.now() - 86_400_000);
    const list = randomUUID();
    await env.db.insertInto('shortlists').values({ id: list, owner_id: s.userId, name: 'L' }).execute();
    await env.db.insertInto('shortlist_players').values({ shortlist_id: list, player_id: p.userId, added_at: yesterday }).execute();
    await env.db.insertInto('analytics_events').values([
      { name: 'scout_search', user_id: s.userId, source: 'server', properties: '{}', created_at: yesterday },
      { name: 'shortlist_add', user_id: s.userId, source: 'server', properties: '{}', created_at: yesterday },
      { name: 'upload_started', user_id: p.userId, source: 'server', properties: '{}', created_at: yesterday },
    ]).execute();
    await rollupAnalytics(env.db, new Date());

    const r = await call('GET', '/v1/admin/metrics?days=7', { token: admin.token });
    expect(r.status).toBe(200);
    const day = yesterday.toISOString().slice(0, 10);
    expect(r.body.to).toBe(day);
    expect(r.body.lastRolledDay).toBe(day);
    expect(r.body.northStar.series).toHaveLength(7);
    expect(r.body.northStar.series.at(-1)).toEqual({ day, value: 1 });
    expect(r.body.northStar.total).toBeGreaterThanOrEqual(1);
    expect(r.body.northStar.definition).toContain('30-day');
    expect(r.body.dau.at(-1).value).toBeGreaterThanOrEqual(2);
    expect(r.body.scoutSearches.at(-1).value).toBeGreaterThanOrEqual(1);
    expect(r.body.uploads.at(-1).value).toBeGreaterThanOrEqual(1);
    const scoutFunnel = r.body.funnels.find((f: Json) => f.key === 'scout_discovery');
    expect(scoutFunnel.steps[0]).toEqual({ event: 'scout_search', users: expect.any(Number) });
    expect(scoutFunnel.steps[0].users).toBeGreaterThanOrEqual(scoutFunnel.steps[1].users);
    expect((await call('GET', '/v1/admin/metrics?days=500', { token: admin.token })).status).toBe(400);
  });
});

// ------------------------------------------------------------------------------------ feature flags
describe('feature flags', () => {
  it('seeds the planned flags switched off and evaluates them for anyone', async () => {
    const r = await call('GET', '/v1/flags');
    expect(r.status).toBe(200);
    expect(r.body.flags).toEqual({ for_you_personalization: false, hls_streaming: false, nl_scout_search: false });
  });

  it('keeps flag administration to admins with MFA', async () => {
    const plain = await newUser('f-plain', 'f_plain');
    const noMfa = await staff('f-nomfa', 'f_nomfa', 'admin', false);
    const mod = await staff('f-mod', 'f_mod', 'moderator');
    const body = { key: 'sneaky', description: 'x', enabled: true, rolloutPercentage: 100 };
    for (const u of [plain, mod]) {
      expect((await call('POST', '/v1/admin/flags', { token: u.token, body })).status).toBe(403);
      expect((await call('PATCH', '/v1/admin/flags/hls_streaming', { token: u.token, body: { enabled: true } })).status).toBe(403);
      expect((await call('DELETE', '/v1/admin/flags/hls_streaming', { token: u.token })).status).toBe(403);
      expect((await call('GET', '/v1/admin/flags', { token: u.token })).status).toBe(403);
    }
    expect((await call('POST', '/v1/admin/flags', { token: noMfa.token, body })).body.code).toBe('MFA_REQUIRED');
    expect(await env.db.selectFrom('feature_flags').select('key').where('key', '=', 'sneaky').executeTakeFirst()).toBeUndefined();
  });

  it('creates, changes and deletes flags with an audit trail, and applies audience rules', async () => {
    const admin = await staff('f-admin', 'f_admin', 'admin');
    const s = await scout('f-scout', 'f_scout');
    const fan = await newUser('f-fan', 'f_fan', ['fan']);
    const created = await call('POST', '/v1/admin/flags', { token: admin.token, body: { key: 'scout_beta', description: 'Beta tools for scouts', enabled: true, rolloutPercentage: 100, audience: { roles: ['scout'] } } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: 'scout_beta', enabled: true, rolloutPercentage: 100, audience: { roles: ['scout'] }, updatedBy: admin.userId });
    expect((await call('POST', '/v1/admin/flags', { token: admin.token, body: { key: 'scout_beta', description: 'again' } })).body.code).toBe('FLAG_EXISTS');

    expect((await call('GET', '/v1/flags', { token: s.token })).body.flags.scout_beta).toBe(true);
    expect((await call('GET', '/v1/flags', { token: fan.token })).body.flags.scout_beta).toBe(false);
    expect((await call('GET', '/v1/flags')).body.flags.scout_beta).toBe(false);

    const changed = await call('PATCH', '/v1/admin/flags/scout_beta', { token: admin.token, body: { audience: { countries: ['MA'] } } });
    expect(changed.body.audience).toEqual({ countries: ['MA'] });
    expect((await call('GET', '/v1/flags', { token: s.token })).body.flags.scout_beta).toBe(false); // the scout signed up in EG
    expect((await call('PATCH', '/v1/admin/flags/scout_beta', { token: admin.token, body: {} })).status).toBe(400);

    const hidden = await call('PATCH', '/v1/admin/flags/scout_beta', { token: admin.token, body: { clientVisible: false } });
    expect(hidden.status).toBe(200);
    expect('scout_beta' in (await call('GET', '/v1/flags', { token: s.token })).body.flags).toBe(false);

    expect((await call('DELETE', '/v1/admin/flags/scout_beta', { token: admin.token })).status).toBe(204);
    expect((await call('DELETE', '/v1/admin/flags/scout_beta', { token: admin.token })).status).toBe(404);
    const trail = await env.db.selectFrom('audit_logs').select(['action', 'actor_id', 'metadata']).where('target_kind', '=', 'feature_flag').orderBy('id').execute();
    expect(trail.map((a) => a.action)).toEqual(['flag.created', 'flag.updated', 'flag.updated', 'flag.deleted']);
    expect(trail.every((a) => a.actor_id === admin.userId)).toBe(true);
    expect((trail[1]!.metadata as Json).before).toMatchObject({ audience: { roles: ['scout'] } });
  });

  it('evaluates server-side with deterministic bucketing and treats unknown flags as off', async () => {
    const admin = await staff('f-admin2', 'f_admin2', 'admin');
    await call('POST', '/v1/admin/flags', { token: admin.token, body: { key: 'half_rollout', description: 'Half', enabled: true, rolloutPercentage: 50 } });
    invalidateFlags(env.db);
    const actors = Array.from({ length: 40 }, (_, i) => ({ userId: `0192e000-0000-7000-8000-${String(i).padStart(12, '0')}`, roles: ['fan' as const], status: 'active' as const, ageBand: 'adult' as const, mfa: false, guardianOf: [], consents: new Set<never>() }));
    const first = await Promise.all(actors.map((a) => isEnabled(env.deps, 'half_rollout', a)));
    const second = await Promise.all(actors.map((a) => isEnabled(env.deps, 'half_rollout', a)));
    expect(second).toEqual(first);
    expect(first.some(Boolean)).toBe(true);
    expect(first.every(Boolean)).toBe(false);
    expect(await isEnabled(env.deps, 'no_such_flag', actors[0]!)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------ operations
describe('health, readiness and request logging', () => {
  it('reports health and readiness with a database ping', async () => {
    const h = await call('GET', '/v1/health');
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
    expect(typeof h.body.databaseLatencyMs).toBe('number');
    const r = await call('GET', '/v1/ready');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ready: true, checks: { database: 'ok', migrations: 'ok' } });
  });

  it('answers 503 when the database is unreachable, and reports unexpected errors with the route pattern', async () => {
    const captured: ErrorContext[] = [];
    const reporter: ErrorReporter = { capture: (_err, context) => { captured.push(context); } };
    const deadDb = createDb('postgres://fp:fp@127.0.0.1:1/none', 1);
    const app = await buildApp({ ...env.deps, db: deadDb, errorReporter: reporter }, { logger: false });
    try {
      const h = await app.inject({ method: 'GET', url: '/v1/health' });
      expect(h.statusCode).toBe(503);
      expect(h.json()).toMatchObject({ status: 'degraded', checks: { database: 'down' } });
      expect((await app.inject({ method: 'GET', url: '/v1/ready' })).statusCode).toBe(503);
      const feed = await app.inject({ method: 'GET', url: `/v1/videos/${randomUUID()}` });
      expect(feed.statusCode).toBe(500);
      expect(captured.at(-1)).toMatchObject({ method: 'GET', route: '/v1/videos/:videoId', userHash: null, requestId: feed.headers['x-request-id'] });
    } finally {
      await app.close();
      await deadDb.destroy();
    }
  });

  it('echoes a request id, keeping a well-formed one from the caller', async () => {
    const given = await call('GET', '/v1/health', { headers: { 'x-request-id': 'edge-req-12345678' } });
    expect(given.headers['x-request-id']).toBe('edge-req-12345678');
    const junk = await call('GET', '/v1/health', { headers: { 'x-request-id': 'bad id with spaces' } });
    expect(junk.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes one structured access line per request with request id, route, status, latency and a user hash', async () => {
    const lines: Json[] = [];
    const app = await buildApp(env.deps, { logger: { level: 'info', stream: { write: (l: string) => lines.push(JSON.parse(l)) } } });
    try {
      const u = await newUser('log-user', 'log_user');
      const res = await app.inject({ method: 'GET', url: '/v1/profiles/log_user?utm=x', headers: { authorization: `Bearer ${u.token}`, 'x-request-id': 'req-abcdef-123' } });
      expect(res.statusCode).toBe(200);
      const done = lines.filter((l) => l.msg === 'request completed');
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ reqId: 'req-abcdef-123', method: 'GET', route: '/v1/profiles/:handle', status: 200, user: expect.stringMatching(/^[0-9a-f]{16}$/) });
      expect(typeof done[0]!.ms).toBe('number');
      expect(JSON.stringify(lines)).not.toContain(u.userId);
      expect(lines.some((l) => l.msg === 'incoming request')).toBe(false); // debug only
    } finally {
      await app.close();
    }
  });

  it('the log-based reporter writes one structured line without the raw user id', async () => {
    const lines: Json[] = [];
    const app = Fastify({ logger: { level: 'error', stream: { write: (l: string) => lines.push(JSON.parse(l)) } } });
    app.addHook('onRequest', async (req) => { req.actorId = '0192e000-0000-7000-8000-000000000001'; });
    app.setErrorHandler((err, req, reply) => problemHandler(err as Error, req, reply, undefined, () => 'hashed-user'));
    app.get('/boom/:id', async () => { throw new Error('kaboom'); });
    const res = await app.inject({ method: 'GET', url: '/boom/123?secret=1' });
    expect(res.statusCode).toBe(500);
    expect(res.json().detail).toBe('unexpected error');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'unhandled error', route: '/boom/:id', userHash: 'hashed-user', method: 'GET' });
    expect(JSON.stringify(lines[0])).not.toContain('0192e000-0000-7000-8000-000000000001');
    await app.close();
  });
});

// ------------------------------------------------------------------------------------ SEO
describe('sitemap privacy filtering', () => {
  it('lists only indexable players and their public published clips', async () => {
    const open = await newUser('seo-open', 'seo_open');
    const unlisted = await newUser('seo-unlisted', 'seo_unlisted');
    const priv = await newUser('seo-private', 'seo_private');
    const noDiscovery = await newUser('seo-nodisc', 'seo_nodisc');
    const fan = await newUser('seo-fan', 'seo_fan', ['fan']);
    const demo = await newUser('seo-demo', 'seo_demo');
    await call('PATCH', `/v1/users/${unlisted.userId}/privacy`, { token: unlisted.token, body: { profileVisibility: 'unlisted' } });
    await call('PATCH', `/v1/users/${priv.userId}/privacy`, { token: priv.token, body: { profileVisibility: 'private' } });
    await call('PATCH', `/v1/users/${noDiscovery.userId}/privacy`, { token: noDiscovery.token, body: { allowScoutDiscovery: false } });
    await env.db.updateTable('users').set({ is_demo: true }).where('id', '=', demo.userId).execute();

    // Minors: one whose guardian consented to a public profile, one whose consent was withdrawn.
    const kid = async (sub: string, handle: string, consent: boolean[]) => {
      const token = await env.token(sub);
      const id = (await call('POST', '/v1/onboarding/register', { token, body: { handle, displayName: handle, dob: '2010-01-01', countryCode: 'EG', roles: ['player'] } })).body.userId as string;
      await env.db.updateTable('users').set({ status: 'active' }).where('id', '=', id).execute();
      await env.db.updateTable('privacy_settings').set({ profile_visibility: 'public' }).where('user_id', '=', id).execute();
      let t = Date.now() - 10_000;
      for (const granted of consent) {
        await env.db.insertInto('consents').values({ id: randomUUID(), subject_user_id: id, granted_by: id, purpose: 'public_profile', granted, policy_version: 't', created_at: new Date(t += 1000) }).execute();
      }
      return id;
    };
    const kidOk = await kid('seo-kid-ok', 'seo_kid_ok', [true]);
    const kidWithdrawn = await kid('seo-kid-no', 'seo_kid_no', [true, false]);

    const vPublic = await clip(open.userId);
    const vFollowers = await clip(open.userId, { visibility: 'followers' });
    const vPrivate = await clip(open.userId, { visibility: 'private' });
    const vProcessing = await clip(open.userId, { status: 'processing', published_at: null });
    const vDeleted = await clip(open.userId, { status: 'deleted', deleted_at: new Date() });
    const vUnlistedOwner = await clip(unlisted.userId);
    const vKid = await clip(kidOk);
    const vKidWithdrawn = await clip(kidWithdrawn);

    const r = await call('GET', '/v1/sitemap');
    expect(r.status).toBe(200);
    const handles = r.body.profiles.map((p: Json) => p.handle);
    expect(handles).toEqual(expect.arrayContaining(['seo_open', 'seo_kid_ok']));
    for (const h of ['seo_unlisted', 'seo_private', 'seo_nodisc', 'seo_fan', 'seo_demo', 'seo_kid_no']) expect(handles).not.toContain(h);
    const ids = r.body.videos.map((v: Json) => v.id);
    expect(ids).toEqual(expect.arrayContaining([vPublic, vKid]));
    for (const id of [vFollowers, vPrivate, vProcessing, vDeleted, vUnlistedOwner, vKidWithdrawn]) expect(ids).not.toContain(id);
    expect(fan.userId).toBeTruthy();

    expect((await call('GET', '/v1/seo/profiles/seo_open')).body).toMatchObject({ handle: 'seo_open', displayName: 'seo_open', verified: false });
    for (const h of ['seo_unlisted', 'seo_private', 'seo_kid_no', 'no_such_user', '..']) expect((await call('GET', `/v1/seo/profiles/${h}`)).status).toBe(404);
  });
});

// Keep `sql` referenced for ad-hoc debugging queries in this file.
void sql;
