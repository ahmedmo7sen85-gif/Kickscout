import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, SERVICE_TOKEN } from './helpers.js';
import type { TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env?.close();
});

type Json = Record<string, any>;
async function call(method: string, url: string, opts: { token?: string; body?: unknown; service?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.service) headers.authorization = `Bearer ${SERVICE_TOKEN}`;
  const res = await env.app.inject({ method: method as 'GET', url, headers, ...(opts.body !== undefined ? { payload: opts.body as Json } : {}) });
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Json, headers: res.headers };
}

async function registerUser(sub: string, body: Json, claims: Json = {}) {
  const token = await env.token(sub, claims);
  const res = await call('POST', '/v1/onboarding/register', { token, body });
  return { token, res, userId: res.body?.userId as string };
}

const adult = (handle: string, roles = ['player']) => ({ handle, displayName: handle, dob: '1995-04-02', countryCode: 'EG', roles });
const minor = (handle: string) => ({ handle, displayName: handle, dob: '2011-03-15', countryCode: 'EG', roles: ['player'] });

async function grantAnalysisConsent(token: string, subjectId: string) {
  const r = await call('POST', '/v1/consents', { token, body: { subjectId, purpose: 'ai_analysis', granted: true, policyVersion: 'test-1' } });
  expect(r.status).toBe(204);
}

async function readyVideo(token: string, videoType = 'dribbling') {
  const created = await call('POST', '/v1/uploads', { token, body: { contentType: 'video/mp4', sizeBytes: 1000, videoType, subject: 'me' } });
  expect(created.status).toBe(201);
  const videoId = created.body.videoId as string;
  const key = new URL(created.body.upload.url).pathname.slice(1);
  env.storage.objects.set(key, { sizeBytes: 1000, contentType: 'video/mp4' });
  expect((await call('POST', `/v1/uploads/${videoId}/complete`, { token })).status).toBe(200);
  const processed = await call('POST', `/internal/media/${videoId}/processed`, {
    service: true, body: { status: 'ready', hlsKey: `hls/${videoId}/index.m3u8`, thumbnailKey: `thumbs/${videoId}.jpg`, durationMs: 30000 },
  });
  expect(processed.status).toBe(204);
  return videoId;
}

const dribbles = (n: number, outcome: (i: number) => 'success' | 'fail' = () => 'success', pressure = 'low') =>
  Array.from({ length: n }, (_, i) => ({ skill: 'dribbling', eventType: 'dribble_attempt', outcome: outcome(i), tStartMs: i * 2000, tEndMs: i * 2000 + 1200, confidence: 0.9, context: { pressure } }));

async function submitResults(analysisId: string, observations: Json[]) {
  return call('POST', `/internal/analyses/${analysisId}/results`, {
    service: true,
    body: {
      status: 'done',
      quality: { score: 82, readiness: 0.85, limitations: ['ball not visible from 12.0s to 13.4s'] },
      agentRuns: [{ agent: 'technical-skills', version: '0.1.0', status: 'ok', confidence: 0.8, observations }],
    },
  });
}

describe('registration and age rules', () => {
  it('registers an adult as active and returns the profile', async () => {
    const { token, res } = await registerUser('adult-1', adult('adult_one'));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'active', guardianRequired: false });
    const me = await call('GET', '/v1/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.profile.handle).toBe('adult_one');
    expect(me.body.roles).toEqual(['player']);
  });

  it('refuses duplicate registration and taken handles', async () => {
    const { token } = await registerUser('adult-dup', adult('dup_one'));
    expect((await call('POST', '/v1/onboarding/register', { token, body: adult('dup_two') })).body.code).toBe('ALREADY_REGISTERED');
    expect((await registerUser('adult-dup-2', adult('dup_one'))).res.body.code).toBe('HANDLE_TAKEN');
  });

  it('refuses under-13 sign-ups without storing anything', async () => {
    const { res } = await registerUser('kid-12', { ...minor('too_young'), dob: '2016-01-01' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('UNDER_MINIMUM_AGE');
    const row = await env.db.selectFrom('users').select('id').where('idp_subject', '=', 'kid-12').executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('rejects unauthenticated and malformed requests with problem details', async () => {
    const anon = await call('POST', '/v1/onboarding/register', { body: adult('nobody') });
    expect(anon.status).toBe(401);
    expect(anon.headers['content-type']).toContain('application/problem+json');
    const bad = await call('POST', '/v1/onboarding/register', { token: await env.token('bad-1'), body: { handle: 'x' } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect(bad.body.errors.length).toBeGreaterThan(0);
    const forged = await call('GET', '/v1/me', { token: 'not-a-jwt' });
    expect(forged.body.code).toBe('INVALID_TOKEN');
  });
});

describe('youth safety', () => {
  let kid: { token: string; userId: string };
  let guardian: { token: string; userId: string };

  beforeAll(async () => {
    const k = await registerUser('kid-1', minor('kid_winger'));
    kid = { token: k.token, userId: k.userId };
    const g = await registerUser('guardian-1', adult('parent_one', ['fan']), { email: 'parent@example.com', email_verified: true });
    guardian = { token: g.token, userId: g.userId };
  });

  it('keeps a minor pending until a guardian consents', async () => {
    const me = await call('GET', '/v1/me', { token: kid.token });
    expect(me.body).toMatchObject({ status: 'pending_consent', guardianRequired: true, ageGroup: 'u16' });
    const upload = await call('POST', '/v1/uploads', { token: kid.token, body: { contentType: 'video/mp4', sizeBytes: 10, videoType: 'training', subject: 'me' } });
    expect(upload.body.code).toBe('CONSENT_REQUIRED');
  });

  it('binds the invitation to the guardian email', async () => {
    const inv = await call('POST', '/v1/guardians/invitations', { token: kid.token, body: { guardianEmail: 'parent@example.com' } });
    expect(inv.status).toBe(201);
    const { token } = env.mailer.invitations.at(-1)!;

    const stranger = await registerUser('stranger-1', adult('stranger', ['fan']), { email: 'other@example.com', email_verified: true });
    expect((await call('POST', '/v1/guardians/invitations/accept', { token: stranger.token, body: { token } })).body.code).toBe('EMAIL_MISMATCH');

    expect((await call('POST', '/v1/guardians/invitations/accept', { token: guardian.token, body: { token } })).status).toBe(204);
    expect((await call('POST', '/v1/guardians/invitations/accept', { token: guardian.token, body: { token } })).body.code).toBe('INVITATION_INVALID');
  });

  it('lets only the guardian grant a minor’s consents', async () => {
    const own = await call('POST', '/v1/consents', { token: kid.token, body: { subjectId: kid.userId, purpose: 'account', granted: true, policyVersion: 'test-1' } });
    expect(own.body.code).toBe('GUARDIAN_REQUIRED'); // a minor cannot consent for themselves

    for (const purpose of ['account', 'ai_analysis']) {
      const r = await call('POST', '/v1/consents', { token: guardian.token, body: { subjectId: kid.userId, purpose, granted: true, policyVersion: 'test-1' } });
      expect(r.status).toBe(204);
    }
    expect((await call('GET', '/v1/me', { token: kid.token })).body.status).toBe('active');
    const selfGrant = await call('POST', '/v1/consents', { token: kid.token, body: { subjectId: kid.userId, purpose: 'public_profile', granted: true, policyVersion: 'test-1' } });
    expect(selfGrant.body.code).toBe('GUARDIAN_REQUIRED');

    const state = await call('GET', `/v1/users/${kid.userId}/consents`, { token: guardian.token });
    expect(state.body.consents.map((c: Json) => c.purpose).sort()).toEqual(['account', 'ai_analysis']);
  });

  it('hides a minor’s profile until the guardian opens it, then hides age, email and city from the public', async () => {
    await call('PATCH', `/v1/profiles/${kid.userId}`, { token: guardian.token, body: { regionCode: 'EG-cairo', player: { primaryPosition: 'RW', preferredFoot: 'left' } } });
    expect((await call('GET', '/v1/profiles/kid_winger')).status).toBe(404);

    await call('POST', '/v1/consents', { token: guardian.token, body: { subjectId: kid.userId, purpose: 'public_profile', granted: true, policyVersion: 'test-1' } });
    const pub = await call('GET', '/v1/profiles/kid_winger');
    expect(pub.status).toBe(200);
    expect(pub.body.region).toEqual({ macro: 'north-africa', country: 'EG', city: null });
    expect(pub.body.ageGroup).toBeNull();
    expect(pub.body.email).toBeNull();
    expect(pub.body.canDirectMessage).toBe(false);
    expect(pub.body.player).toEqual({ primaryPosition: 'RW', secondaryPositions: [], preferredFoot: 'left' });

    const asGuardian = await call('GET', '/v1/profiles/kid_winger', { token: guardian.token });
    expect(asGuardian.body.region.city).toBe('EG-cairo');
  });

  it('holds contact-harvesting comments on a minor’s video and keeps minors’ analysis from the public', async () => {
    const videoId = await readyVideo(kid.token);
    await call('PUT', `/v1/users/${kid.userId}/follow`, { token: guardian.token });
    const c = await call('POST', `/v1/videos/${videoId}/comments`, { token: guardian.token, body: { body: 'add me on whatsapp +20 100 123 4567' } });
    expect(c.status).toBe(201);
    expect(c.body.status).toBe('held');
    expect((await call('GET', `/v1/videos/${videoId}/comments`)).body.items).toEqual([]);

    const fan = await registerUser('fan-1', adult('fan_one', ['fan']));
    // comments on a minor's video default to followers only
    expect((await call('POST', `/v1/videos/${videoId}/comments`, { token: fan.token, body: { body: 'great skill' } })).body.code).toBe('FOLLOWERS_ONLY');
    expect((await call('GET', `/v1/players/${kid.userId}/dna`, { token: fan.token })).status).toBe(403);
    expect((await call('GET', `/v1/players/${kid.userId}/dna`, { token: guardian.token })).status).toBe(200);
  });
});

describe('upload, feed and social', () => {
  let player: { token: string; userId: string };
  beforeAll(async () => {
    const p = await registerUser('player-feed', adult('feed_player'));
    player = { token: p.token, userId: p.userId };
  });

  it('refuses to complete an upload that has not arrived or does not match', async () => {
    const created = await call('POST', '/v1/uploads', { token: player.token, body: { contentType: 'video/mp4', sizeBytes: 5000, videoType: 'match', subject: 'me' } });
    const id = created.body.videoId;
    expect((await call('POST', `/v1/uploads/${id}/complete`, { token: player.token })).body.code).toBe('UPLOAD_MISSING');
    env.storage.objects.set(new URL(created.body.upload.url).pathname.slice(1), { sizeBytes: 9999, contentType: 'video/mp4' });
    expect((await call('POST', `/v1/uploads/${id}/complete`, { token: player.token })).body.code).toBe('UPLOAD_MISMATCH');
  });

  it('rejects internal callbacks without the service token', async () => {
    const r = await call('POST', '/internal/media/00000000-0000-7000-8000-000000000000/processed', { token: player.token, body: { status: 'ready' } });
    expect(r.status).toBe(401);
  });

  it('shows ready videos in the feed and labels unbuilt tabs Coming Soon', async () => {
    const videoId = await readyVideo(player.token);
    const feed = await call('GET', '/v1/feed?tab=for_you&limit=50');
    expect(feed.status).toBe(200);
    const item = feed.body.items.find((v: Json) => v.id === videoId);
    expect(item.playbackUrl).toBe(`https://cdn.test/hls/${videoId}/index.m3u8`);
    expect(feed.body.capability.status).toBe('live');

    const newTalent = await call('GET', '/v1/feed?tab=new_talent&limit=50');
    expect(newTalent.body.items.some((v: Json) => v.id === videoId)).toBe(true);

    const trending = await call('GET', '/v1/feed?tab=trending');
    expect(trending.body.items).toEqual([]);
    expect(trending.body.capability.label).toEqual({ en: 'Coming Soon', ar: 'قريبًا' });
  });

  it('paginates the feed with a stable cursor', async () => {
    await readyVideo(player.token);
    await readyVideo(player.token);
    const first = await call('GET', '/v1/feed?limit=1');
    expect(first.body.nextCursor).toBeTruthy();
    const second = await call('GET', `/v1/feed?limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    expect((await call('GET', '/v1/feed?cursor=garbage')).body.code).toBe('INVALID_CURSOR');
  });

  it('counts likes, and removes a blocked user’s videos from the feed', async () => {
    const videoId = await readyVideo(player.token);
    const viewer = await registerUser('viewer-1', adult('viewer_one', ['fan']));
    await call('PUT', `/v1/videos/${videoId}/like`, { token: viewer.token });
    await call('PUT', `/v1/videos/${videoId}/like`, { token: viewer.token });
    const v = await call('GET', `/v1/videos/${videoId}`, { token: viewer.token });
    expect(v.body).toMatchObject({ likes: 1, likedByMe: true });

    await call('PUT', `/v1/users/${player.userId}/block`, { token: viewer.token });
    const feed = await call('GET', '/v1/feed?limit=50', { token: viewer.token });
    expect(feed.body.items.some((i: Json) => i.owner.userId === player.userId)).toBe(false);
    expect((await call('POST', `/v1/videos/${videoId}/comments`, { token: viewer.token, body: { body: 'hi' } })).body.code).toBe('BLOCKED');
  });

  it('only lets uploader roles upload', async () => {
    const fan = await registerUser('fan-upload', adult('fan_upload', ['fan']));
    const r = await call('POST', '/v1/uploads', { token: fan.token, body: { contentType: 'video/mp4', sizeBytes: 10, videoType: 'training', subject: 'me' } });
    expect(r.body.code).toBe('ROLE_REQUIRED');
  });

  it('raises reports about minors and child safety to the top of the queue', async () => {
    const r = await call('POST', '/v1/reports', { token: player.token, body: { targetKind: 'user', targetId: player.userId, reason: 'child_safety' } });
    expect(r.status).toBe(202);
    const row = await env.db.selectFrom('reports').select('priority').where('reporter_id', '=', player.userId).executeTakeFirstOrThrow();
    expect(row.priority).toBe(0);
  });
});

describe('analysis and Player DNA', () => {
  let player: { token: string; userId: string };
  beforeAll(async () => {
    const p = await registerUser('player-ai', adult('ai_player'));
    player = { token: p.token, userId: p.userId };
    // AI analysis is a separate consent, never granted by default
    await grantAnalysisConsent(player.token, player.userId);
    await call('PATCH', `/v1/profiles/${player.userId}`, { token: player.token, body: { player: { primaryPosition: 'LW', preferredFoot: 'right' } } });
  });

  it('queues an analysis, labels unbuilt capabilities, and blocks duplicates and paid tiers', async () => {
    const videoId = await readyVideo(player.token);
    const req = await call('POST', `/v1/videos/${videoId}/analyses`, { token: player.token, body: { frameMs: 1200, box: { x: 0.4, y: 0.2, w: 0.1, h: 0.3 } } });
    expect(req.status).toBe(202);
    expect(req.body.status).toBe('queued');
    expect(req.body.selection.confirmed).toBe(true);
    const tactical = req.body.capabilities.find((c: Json) => c.key === 'analysis.tactical');
    expect(tactical.label.en).toBe('Requires Model Integration');

    expect((await call('POST', `/v1/videos/${videoId}/analyses`, { token: player.token, body: { frameMs: 0, box: { x: 0.4, y: 0.2, w: 0.1, h: 0.3 } } })).body.code).toBe('ANALYSIS_IN_PROGRESS');
    const other = await readyVideo(player.token);
    expect((await call('POST', `/v1/videos/${other}/analyses`, { token: player.token, body: { frameMs: 0, tier: 'advanced', box: { x: 0.4, y: 0.2, w: 0.1, h: 0.3 } } })).body.code).toBe('PLAN_REQUIRED');
    expect((await call('POST', `/v1/videos/${other}/analyses`, { token: player.token, body: { frameMs: 0, box: { x: 0.95, y: 0.2, w: 0.1, h: 0.3 } } })).status).toBe(400);
  });

  it('refuses analysis without AI analysis consent', async () => {
    const p = await registerUser('player-no-consent', adult('no_consent'));
    const videoId = await readyVideo(p.token);
    const r = await call('POST', `/v1/videos/${videoId}/analyses`, { token: p.token, body: { frameMs: 0, box: { x: 0.4, y: 0.2, w: 0.1, h: 0.3 } } });
    expect(r.body.code).toBe('CONSENT_REQUIRED');
  });

  it('shows no DNA before evidence exists', async () => {
    const dna = await call('GET', `/v1/players/${player.userId}/dna`, { token: player.token });
    expect(dna.body.dna).toBeNull();
    expect(dna.body.message.en).toMatch(/No analysis evidence yet/);
  });

  it('withholds a score on thin evidence, then explains a score once evidence is enough', async () => {
    const v1 = await readyVideo(player.token);
    const a1 = await call('POST', `/v1/videos/${v1}/analyses`, { token: player.token, body: { frameMs: 0, box: { x: 0.4, y: 0.2, w: 0.1, h: 0.3 } } });
    expect((await submitResults(a1.body.id, dribbles(3))).status).toBe(204);
    expect((await submitResults(a1.body.id, dribbles(3))).body.code).toBe('ALREADY_FINISHED');

    let skill = await call('GET', `/v1/players/${player.userId}/skills/dribbling`, { token: player.token });
    expect(skill.body).toMatchObject({ status: 'insufficient_evidence', score: null, evidenceCount: 3, calibrated: false });
    expect(skill.body.capability.label.en).toBe('Prototype');

    const v2 = await readyVideo(player.token);
    const a2 = await call('POST', `/v1/videos/${v2}/analyses`, { token: player.token, body: { frameMs: 0, box: { x: 0.4, y: 0.2, w: 0.1, h: 0.3 } } });
    await submitResults(a2.body.id, [...dribbles(8, (i) => (i % 4 === 0 ? 'fail' : 'success'), 'high'), { ...dribbles(1)[0], excludedReason: 'low_tracking' }]);

    skill = await call('GET', `/v1/players/${player.userId}/skills/dribbling`, { token: player.token });
    expect(skill.body.status).toBe('assessed');
    expect(skill.body.score).toBeGreaterThan(50);
    expect(skill.body.score).toBeLessThan(90);
    expect(skill.body.evidenceCount).toBe(11);
    expect(skill.body.explanation.distinctVideos).toBe(2);
    expect(skill.body.clips).toHaveLength(11);
    expect(new Set(skill.body.clips.map((c: Json) => c.videoId))).toEqual(new Set([v1, v2]));

    const analysis = await call('GET', `/v1/analyses/${a2.body.id}`, { token: player.token });
    expect(analysis.body.quality.limitations).toEqual(['ball not visible from 12.0s to 13.4s']);

    const dna = await call('GET', `/v1/players/${player.userId}/dna`, { token: player.token });
    expect(dna.body.version).toBe(2);
    expect(dna.body.dna.position).toEqual({ primary: 'LW', secondary: [], source: 'user_provided' });
    // one skill is not enough for an index or a strengths list
    expect(dna.body.dna.strengths).toEqual([]);
    expect(dna.body.dna.positionIndex.score).toBeNull();
  });

  it('waits for the named player to confirm before using another player’s footage', async () => {
    const other = await registerUser('player-named', adult('named_player'));
    await grantAnalysisConsent(other.token, other.userId);
    const videoId = await readyVideo(player.token);
    const req = await call('POST', `/v1/videos/${videoId}/analyses`, { token: player.token, body: { frameMs: 0, claimedPlayerId: other.userId, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.4 } } });
    expect(req.body.selection.confirmed).toBe(false);
    await submitResults(req.body.id, dribbles(6));
    expect((await call('GET', `/v1/players/${other.userId}/dna`, { token: other.token })).body.dna).toBeNull();

    const selection = await env.db.selectFrom('analysis_runs').select('target_selection_id').where('id', '=', req.body.id).executeTakeFirstOrThrow();
    expect((await call('POST', `/v1/selections/${selection.target_selection_id}/confirm`, { token: player.token })).status).toBe(403);
    expect((await call('POST', `/v1/selections/${selection.target_selection_id}/confirm`, { token: other.token })).status).toBe(204);
    const skill = await call('GET', `/v1/players/${other.userId}/skills/dribbling`, { token: other.token });
    expect(skill.body.status).toBe('assessed');
  });
});

describe('platform', () => {
  it('publishes an OpenAPI 3.1 document without internal routes', async () => {
    const doc = await call('GET', '/v1/openapi.json');
    expect(doc.body.openapi).toBe('3.1.0');
    expect(doc.body.paths['/v1/feed'].get).toBeDefined();
    expect(Object.keys(doc.body.paths).some((p) => p.startsWith('/internal'))).toBe(false);
  });

  it('keeps the audit log append-only', async () => {
    await expect(env.db.deleteFrom('audit_logs').execute()).rejects.toThrow(/append-only/);
  });
});
