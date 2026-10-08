import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
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

async function registerUser(sub: string, body: Json, claims: Json = {}) {
  const token = await env.token(sub, claims);
  const res = await call('POST', '/v1/onboarding/register', { token, body });
  return { token, res, userId: res.body?.userId as string };
}

const adult = (handle: string, roles = ['player'], country = 'EG') => ({ handle, displayName: handle, dob: '1995-04-02', countryCode: country, roles });
const minor = (handle: string) => ({ handle, displayName: handle, dob: '2011-03-15', countryCode: 'EG', roles: ['player'] });

async function newUser(sub: string, handle: string, roles = ['player']): Promise<User> {
  const r = await registerUser(sub, adult(handle, roles));
  expect(r.res.status).toBe(201);
  return { token: r.token, userId: r.userId };
}

/** Staff accounts: roles are granted in the database, never through the API. Tokens carry MFA. */
async function staff(sub: string, handle: string, role: 'admin' | 'moderator', mfa = true): Promise<User> {
  const u = await newUser(sub, handle, ['fan']);
  await env.db.insertInto('user_roles').values({ user_id: u.userId, role }).execute();
  return { userId: u.userId, token: await env.token(sub, mfa ? { amr: [{ method: 'totp' }], aal: 'aal2' } : {}) };
}

async function startUpload(token: string, extra: Json = {}) {
  return call('POST', '/v1/uploads', { token, body: { contentType: 'video/mp4', sizeBytes: 1000, title: 'Elastico in the cage', skillKey: 'elastico', position: 'LW', foot: 'left', hashtags: ['#Skills', 'cairo'], ...extra } });
}

/** Uploads and completes a video, leaving it `processing` with a queued job, as the worker would find it. */
async function uploadedVideo(token: string, extra: Json = {}) {
  const created = await startUpload(token, extra);
  expect(created.status).toBe(201);
  const videoId = created.body.videoId as string;
  env.storage.objects.set(new URL(created.body.upload.url).pathname.slice(1), { sizeBytes: 1000, contentType: 'video/mp4' });
  const done = await call('POST', `/v1/uploads/${videoId}/complete`, { token });
  expect(done.status).toBe(200);
  return videoId;
}

/** Stands in for the worker (tested in apps/worker): transcoded, AI-tagged, moderated. */
async function workerFinishes(videoId: string, outcome: 'published' | 'review_required', aiTags: [string, number][] = [['elastico', 0.82], ['dribbling', 0.64]]) {
  await env.db.updateTable('videos').set({
    status: outcome, moderation: outcome === 'published' ? 'safe' : 'flagged', playback_key: `playback/${videoId}.mp4`,
    thumbnail_key: `thumbs/${videoId}.jpg`, duration_ms: 12000, published_at: outcome === 'published' ? new Date() : null,
  }).where('id', '=', videoId).execute();
  for (const [skill, confidence] of aiTags) {
    await env.db.insertInto('video_skills').values({ video_id: videoId, skill_key: skill, source: 'ai', confidence })
      .onConflict((oc) => oc.columns(['video_id', 'skill_key', 'source']).doNothing()).execute();
  }
  if (outcome === 'review_required') {
    await env.db.insertInto('moderation_cases').values({ id: crypto.randomUUID(), target_kind: 'video', target_id: videoId, source: 'ai', categories: ['non_football'], priority: 2 }).execute();
  }
}

async function publishedVideo(token: string, extra: Json = {}) {
  const id = await uploadedVideo(token, extra);
  await workerFinishes(id, 'published');
  return id;
}

async function grant(token: string, subjectId: string, purpose: string, granted = true) {
  const r = await call('POST', '/v1/consents', { token, body: { subjectId, purpose, granted, policyVersion: 'test-1' } });
  expect(r.status).toBe(204);
}

// -------------------------------------------------------------------------------------------- auth
describe('registration and authentication', () => {
  it('registers an adult player as active and returns the profile with real stats', async () => {
    const { token, res } = await registerUser('adult-1', adult('adult_one'));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'active', guardianRequired: false });
    const me = await call('GET', '/v1/me', { token });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ roles: ['player'], scoutApplication: 'none', unreadNotifications: 0 });
    expect(me.body.profile).toMatchObject({ handle: 'adult_one', verified: false, isDemo: false, stats: { followers: 0, following: 0, videos: 0, likes: 0 } });
  });

  it('refuses duplicate registration and taken handles', async () => {
    const { token } = await registerUser('adult-dup', adult('dup_one'));
    expect((await call('POST', '/v1/onboarding/register', { token, body: adult('dup_two') })).body.code).toBe('ALREADY_REGISTERED');
    expect((await registerUser('adult-dup-2', adult('dup_one'))).res.body.code).toBe('HANDLE_TAKEN');
  });

  it('refuses under-13 sign-ups without storing anything', async () => {
    const { res } = await registerUser('kid-12', { ...minor('too_young'), dob: '2016-01-01' });
    expect(res.body.code).toBe('UNDER_MINIMUM_AGE');
    expect(await env.db.selectFrom('users').select('id').where('idp_subject', '=', 'kid-12').executeTakeFirst()).toBeUndefined();
  });

  it('never lets sign-up choose scout, moderator or admin', async () => {
    for (const roles of [['scout'], ['admin'], ['moderator']]) {
      expect((await registerUser(`role-${roles[0]}`, adult(`r_${roles[0]}`, roles))).res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('turns a scout sign-up into a fan with a pending scout application', async () => {
    const { token, res } = await registerUser('scout-apply', { ...adult('scout_apply', ['fan']), scoutApplication: { organization: 'Cairo Academy', evidence: 'Licensed scout, see academy site' } });
    expect(res.status).toBe(201);
    const me = await call('GET', '/v1/me', { token });
    expect(me.body.roles).toEqual(['fan']);
    expect(me.body.scoutApplication).toBe('pending');
    expect((await call('GET', '/v1/scout/players', { token })).body.code).toBe('SCOUT_VERIFICATION_REQUIRED');
  });

  it('rejects unauthenticated and malformed requests with problem details', async () => {
    const anon = await call('POST', '/v1/onboarding/register', { body: adult('nobody') });
    expect(anon.status).toBe(401);
    expect(anon.headers['content-type']).toContain('application/problem+json');
    const bad = await call('POST', '/v1/onboarding/register', { token: await env.token('bad-1'), body: { handle: 'x' } });
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect((await call('GET', '/v1/me', { token: 'not-a-jwt' })).body.code).toBe('INVALID_TOKEN');
    expect((await call('GET', '/v1/me', { token: await env.token('never-registered') })).body.code).toBe('NOT_REGISTERED');
  });

  it('allows the configured web origin and no other', async () => {
    const ok = await call('OPTIONS', '/v1/feed', { headers: { origin: 'https://web.test', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://web.test');
    const evil = await call('OPTIONS', '/v1/feed', { headers: { origin: 'https://evil.test', 'access-control-request-method': 'GET' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------- minors
describe('youth safety', () => {
  let kid: User;
  let guardian: User;
  let scout: User;

  beforeAll(async () => {
    const k = await registerUser('kid-1', minor('kid_winger'));
    kid = { token: k.token, userId: k.userId };
    const g = await registerUser('guardian-1', adult('parent_one', ['fan']), { email: 'parent@example.com', email_verified: true });
    guardian = { token: g.token, userId: g.userId };
    scout = await newUser('scout-youth', 'scout_youth', ['fan']);
    await env.db.insertInto('user_roles').values({ user_id: scout.userId, role: 'scout' }).execute();
  });

  it('keeps a minor pending until a guardian consents', async () => {
    const me = await call('GET', '/v1/me', { token: kid.token });
    expect(me.body).toMatchObject({ status: 'pending_consent', guardianRequired: true, ageGroup: 'u16' });
    expect((await startUpload(kid.token)).body.code).toBe('CONSENT_REQUIRED');
  });

  it('refuses a scout application from a minor', async () => {
    const r = await registerUser('kid-scout', { ...minor('kid_scout'), roles: ['fan'], scoutApplication: { organization: 'Club', evidence: 'I want to scout players' } });
    expect(r.res.body.code).toBe('ADULTS_ONLY');
  });

  it('binds the guardian invitation to the verified guardian email', async () => {
    expect((await call('POST', '/v1/guardians/invitations', { token: kid.token, body: { guardianEmail: 'parent@example.com' } })).status).toBe(201);
    const { token } = env.mailer.invitations.at(-1)!;
    const stranger = await registerUser('stranger-1', adult('stranger', ['fan']), { email: 'other@example.com', email_verified: true });
    expect((await call('POST', '/v1/guardians/invitations/accept', { token: stranger.token, body: { token } })).body.code).toBe('EMAIL_MISMATCH');
    expect((await call('POST', '/v1/guardians/invitations/accept', { token: guardian.token, body: { token } })).status).toBe(204);
    expect((await call('POST', '/v1/guardians/invitations/accept', { token: guardian.token, body: { token } })).body.code).toBe('INVITATION_INVALID');
  });

  it('lets only the guardian grant a minor’s consents', async () => {
    const own = await call('POST', '/v1/consents', { token: kid.token, body: { subjectId: kid.userId, purpose: 'account', granted: true, policyVersion: 'test-1' } });
    expect(own.body.code).toBe('GUARDIAN_REQUIRED');
    await grant(guardian.token, kid.userId, 'account');
    expect((await call('GET', '/v1/me', { token: kid.token })).body.status).toBe('active');
    const selfOpen = await call('POST', '/v1/consents', { token: kid.token, body: { subjectId: kid.userId, purpose: 'public_profile', granted: true, policyVersion: 'test-1' } });
    expect(selfOpen.body.code).toBe('GUARDIAN_REQUIRED');
  });

  it('keeps a minor’s uploads private until the guardian opens the profile', async () => {
    const videoId = await publishedVideo(kid.token, { visibility: 'public' });
    expect((await env.db.selectFrom('videos').select('visibility').where('id', '=', videoId).executeTakeFirstOrThrow()).visibility).toBe('private');
    expect((await call('GET', `/v1/videos/${videoId}`)).status).toBe(404);
    expect((await call('GET', `/v1/videos/${videoId}`, { token: guardian.token })).status).toBe(200);
  });

  it('hides a minor’s profile until the guardian opens it, then hides age, email and city from the public', async () => {
    await call('PATCH', `/v1/profiles/${kid.userId}`, { token: guardian.token, body: { regionCode: 'EG-cairo', player: { primaryPosition: 'RW', preferredFoot: 'left' } } });
    expect((await call('GET', '/v1/profiles/kid_winger')).status).toBe(404);
    await grant(guardian.token, kid.userId, 'public_profile');
    const pub = await call('GET', '/v1/profiles/kid_winger');
    expect(pub.status).toBe(200);
    expect(pub.body.region).toEqual({ macro: 'north-africa', country: 'EG', city: null });
    expect(pub.body).toMatchObject({ ageGroup: null, email: null, canDirectMessage: false });
    expect((await call('GET', '/v1/profiles/kid_winger', { token: guardian.token })).body.region.city).toBe('EG-cairo');
    // A verified scout may see the age group (needed for youth scouting) but never the city or email.
    const asScout = await call('GET', '/v1/profiles/kid_winger', { token: scout.token });
    expect(asScout.body).toMatchObject({ ageGroup: 'u16', email: null, region: { city: null } });
  });

  it('holds contact-harvesting comments on a minor’s video', async () => {
    const videoId = await publishedVideo(kid.token);
    await call('PATCH', `/v1/videos/${videoId}`, { token: kid.token, body: { visibility: 'public' } });
    await call('PUT', `/v1/users/${kid.userId}/follow`, { token: guardian.token });
    const c = await call('POST', `/v1/videos/${videoId}/comments`, { token: guardian.token, body: { body: 'add me on whatsapp +20 100 123 4567' } });
    expect(c.body.status).toBe('held');
    expect((await call('GET', `/v1/videos/${videoId}/comments`)).body.items).toEqual([]);
    const cases = await env.db.selectFrom('moderation_cases').selectAll().where('target_id', '=', c.body.id).execute();
    expect(cases).toMatchObject([{ source: 'rules', priority: 0, status: 'open' }]);
    const fan = await newUser('fan-1', 'fan_one', ['fan']);
    expect((await call('POST', `/v1/videos/${videoId}/comments`, { token: fan.token, body: { body: 'great skill' } })).body.code).toBe('FOLLOWERS_ONLY');
  });

  it('routes scout contact for a minor to the guardian, and only once the guardian allows it', async () => {
    const msg = { message: 'We would like to invite your player to a trial session.' };
    expect((await call('POST', `/v1/scout/players/${kid.userId}/contact`, { token: scout.token, body: msg })).body.code).toBe('CONTACT_NOT_ALLOWED');
    await grant(guardian.token, kid.userId, 'scout_contact');
    expect((await call('POST', `/v1/scout/players/${kid.userId}/contact`, { token: scout.token, body: msg })).status).toBe(202);
    expect((await call('GET', '/v1/contact-requests', { token: kid.token })).body.items).toEqual([]);
    const forGuardian = await call('GET', '/v1/contact-requests', { token: guardian.token });
    expect(forGuardian.body.items).toMatchObject([{ viaGuardian: true, player: { handle: 'kid_winger' }, status: 'pending' }]);
    // The minor cannot answer it either.
    expect((await call('POST', `/v1/contact-requests/${forGuardian.body.items[0].id}/respond`, { token: kid.token, body: { accept: true } })).status).toBe(404);
  });
});

// -------------------------------------------------------------------------------------------- jurisdiction
describe('configurable age rules', () => {
  it('applies a country rule only after an admin records its legal review', async () => {
    const admin = await staff('admin-juris', 'admin_juris', 'admin');
    const teen = { handle: 'sa_teen', displayName: 'Teen', dob: '2009-01-01', countryCode: 'SA', roles: ['player'] };
    await call('PUT', '/v1/admin/jurisdiction-rules/SA', { token: admin.token, body: { minimumAge: 13, guardianConsentAge: 16, legallyReviewed: false } });
    expect((await registerUser('sa-1', teen)).res.body.guardianRequired).toBe(true);
    await call('PUT', '/v1/admin/jurisdiction-rules/SA', { token: admin.token, body: { minimumAge: 13, guardianConsentAge: 16, legallyReviewed: true, source: 'counsel memo 2026-10' } });
    expect((await registerUser('sa-2', { ...teen, handle: 'sa_teen2' })).res.body).toMatchObject({ guardianRequired: false, status: 'active' });
    const fan = await newUser('juris-fan', 'juris_fan', ['fan']);
    expect((await call('PUT', '/v1/admin/jurisdiction-rules/SA', { token: fan.token, body: { minimumAge: 13, guardianConsentAge: 13, legallyReviewed: true } })).status).toBe(403);
  });
});

// -------------------------------------------------------------------------------------------- upload
describe('upload and processing', () => {
  let player: User;
  beforeAll(async () => {
    player = await newUser('player-up', 'up_player');
  });

  it('refuses invalid files before signing anything', async () => {
    expect((await startUpload(player.token, { contentType: 'video/x-msvideo' })).body.code).toBe('VALIDATION_FAILED');
    expect((await startUpload(player.token, { contentType: 'application/pdf' })).body.code).toBe('VALIDATION_FAILED');
    expect((await startUpload(player.token, { sizeBytes: 500 * 1024 * 1024 })).body.code).toBe('VALIDATION_FAILED');
    expect((await startUpload(player.token, { title: '' })).body.code).toBe('VALIDATION_FAILED');
  });

  it('refuses to complete an upload that has not arrived or does not match', async () => {
    const created = await startUpload(player.token, { sizeBytes: 5000 });
    const id = created.body.videoId;
    expect((await call('POST', `/v1/uploads/${id}/complete`, { token: player.token })).body.code).toBe('UPLOAD_MISSING');
    env.storage.objects.set(new URL(created.body.upload.url).pathname.slice(1), { sizeBytes: 9999, contentType: 'video/mp4' });
    expect((await call('POST', `/v1/uploads/${id}/complete`, { token: player.token })).body.code).toBe('UPLOAD_MISMATCH');
  });

  it('queues processing in the background and returns immediately', async () => {
    const id = await uploadedVideo(player.token);
    const v = await call('GET', `/v1/videos/${id}`, { token: player.token });
    expect(v.body).toMatchObject({ status: 'processing', playbackUrl: null, skill: 'elastico', hashtags: ['cairo', 'skills'] });
    expect(v.body.tags).toEqual([{ skill: 'elastico', name: { en: 'Elastico', ar: 'إلاستيكو' }, source: 'user', confidence: null }]);
    const job = await env.db.selectFrom('jobs').selectAll().where(sql`payload->>'videoId'`, '=', id).executeTakeFirstOrThrow();
    expect(job).toMatchObject({ kind: 'video.process', status: 'queued' });
    expect((await call('POST', `/v1/uploads/${id}/complete`, { token: player.token })).body.code).toBe('ALREADY_COMPLETED');
  });

  it('cannot bypass moderation: unpublished videos stay hidden and the status cannot be set by the owner', async () => {
    const id = await uploadedVideo(player.token);
    const other = await newUser('peeker', 'peeker');
    expect((await call('GET', `/v1/videos/${id}`, { token: other.token })).status).toBe(404);
    const sneaky = await call('PATCH', `/v1/videos/${id}`, { token: player.token, body: { status: 'published', moderation: 'safe', title: 'Renamed' } });
    expect(sneaky.status).toBe(200);
    expect(sneaky.body).toMatchObject({ status: 'processing', title: 'Renamed' });
    await workerFinishes(id, 'review_required');
    expect((await call('GET', `/v1/videos/${id}`)).status).toBe(404);
    const feed = await call('GET', '/v1/feed?tab=for_you&limit=50');
    expect(feed.body.items.map((v: Json) => v.id)).not.toContain(id);
    // The owner sees why; nobody else ever does.
    expect((await call('GET', `/v1/videos/${id}`, { token: player.token })).body.moderation).toBe('flagged');
  });

  it('lets only the owner correct tags, keeping AI and player tags distinct', async () => {
    const id = await publishedVideo(player.token);
    const before = (await call('GET', `/v1/videos/${id}`)).body;
    expect(before.tags).toEqual([
      { skill: 'elastico', name: { en: 'Elastico', ar: 'إلاستيكو' }, source: 'user', confidence: null },
      { skill: 'dribbling', name: { en: 'Dribbling', ar: 'المراوغة' }, source: 'ai', confidence: 0.64 },
    ]);
    expect(before.moderation).toBeNull();
    const other = await newUser('tag-thief', 'tag_thief');
    expect((await call('POST', `/v1/videos/${id}/tags`, { token: other.token, body: { reject: ['dribbling'] } })).status).toBe(404);
    const fixed = await call('POST', `/v1/videos/${id}/tags`, { token: player.token, body: { add: ['nutmeg'], reject: ['dribbling'] } });
    expect(fixed.body.tags.map((t: Json) => `${t.source}:${t.skill}`)).toEqual(['user:elastico', 'user:nutmeg']);
    const kept = await env.db.selectFrom('video_skills').select(['status']).where('video_id', '=', id).where('skill_key', '=', 'dribbling').executeTakeFirstOrThrow();
    expect(kept.status).toBe('rejected');
  });

  it('lets only the owner, guardian or staff delete', async () => {
    const id = await publishedVideo(player.token);
    const other = await newUser('deleter', 'deleter');
    expect((await call('DELETE', `/v1/videos/${id}`, { token: other.token })).status).toBe(403);
    expect((await call('DELETE', `/v1/videos/${id}`, { token: player.token })).status).toBe(204);
    expect((await call('GET', `/v1/videos/${id}`, { token: player.token })).status).toBe(404);
  });

  it('lists my videos in every state', async () => {
    const mine = await call('GET', '/v1/me/videos?limit=50', { token: player.token });
    expect(new Set(mine.body.items.map((v: Json) => v.status))).toEqual(new Set(['uploading', 'processing', 'review_required', 'published']));
  });
});

// -------------------------------------------------------------------------------------------- profiles
describe('profiles', () => {
  it('stops a player modifying another player’s profile', async () => {
    const a = await newUser('prof-a', 'prof_a');
    const b = await newUser('prof-b', 'prof_b');
    const r = await call('PATCH', `/v1/profiles/${b.userId}`, { token: a.token, body: { displayName: 'hacked' } });
    expect(r.status).toBe(403);
    expect((await call('GET', '/v1/profiles/prof_b')).body.displayName).toBe('prof_b');
  });

  it('cannot forge verification', async () => {
    const a = await newUser('forger', 'forger');
    await call('PATCH', `/v1/profiles/${a.userId}`, { token: a.token, body: { verified: true, verified_at: new Date().toISOString(), displayName: 'Forger' } });
    const p = await call('GET', '/v1/profiles/forger');
    expect(p.body).toMatchObject({ displayName: 'Forger', verified: false });
    expect((await call('POST', `/v1/admin/verification-requests/${crypto.randomUUID()}/decision`, { token: a.token, body: { approve: true } })).status).toBe(403);
  });
});

// -------------------------------------------------------------------------------------------- feed and social
describe('feed, social and notifications', () => {
  let player: User;
  let fan: User;
  let videoId: string;
  beforeAll(async () => {
    player = await newUser('player-feed', 'feed_player');
    fan = await newUser('fan-feed', 'feed_fan', ['fan']);
    videoId = await publishedVideo(player.token, { hashtags: ['firsttouch'] });
  });

  it('shows published videos with counts, and pages with a cursor', async () => {
    const page1 = await call('GET', '/v1/feed?tab=for_you&limit=1');
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await call('GET', `/v1/feed?tab=for_you&limit=1&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
    expect((await call('GET', '/v1/feed?cursor=garbage')).body.code).toBe('INVALID_CURSOR');
  });

  it('likes, saves, comments and follows, notifying the player', async () => {
    expect((await call('PUT', `/v1/videos/${videoId}/like`, { token: fan.token })).status).toBe(204);
    expect((await call('PUT', `/v1/videos/${videoId}/like`, { token: fan.token })).status).toBe(204); // idempotent
    expect((await call('PUT', `/v1/videos/${videoId}/save`, { token: fan.token })).status).toBe(204);
    expect((await call('POST', `/v1/videos/${videoId}/comments`, { token: fan.token, body: { body: 'What a first touch' } })).body.status).toBe('visible');
    expect((await call('PUT', `/v1/users/${player.userId}/follow`, { token: fan.token })).status).toBe(204);
    const v = await call('GET', `/v1/videos/${videoId}`, { token: fan.token });
    expect(v.body).toMatchObject({ likes: 1, saves: 1, comments: 1, likedByMe: true, savedByMe: true });
    expect((await call('GET', '/v1/me/saves', { token: fan.token })).body.items.map((x: Json) => x.id)).toEqual([videoId]);
    const notes = await call('GET', '/v1/notifications', { token: player.token });
    expect(notes.body.items.map((n: Json) => n.kind).sort()).toEqual(['comment', 'follow', 'like']);
    expect((await call('GET', '/v1/me', { token: player.token })).body.unreadNotifications).toBe(3);
    await call('POST', '/v1/notifications/read', { token: player.token, body: {} });
    expect((await call('GET', '/v1/me', { token: player.token })).body.unreadNotifications).toBe(0);
    const prof = await call('GET', '/v1/profiles/feed_player', { token: fan.token });
    expect(prof.body).toMatchObject({ followedByMe: true, stats: { followers: 1, videos: 1, likes: 1 } });
  });

  it('shows followed players in the Following tab and requires sign-in for it', async () => {
    expect((await call('GET', '/v1/feed?tab=following')).status).toBe(401);
    const f = await call('GET', '/v1/feed?tab=following', { token: fan.token });
    expect(f.body.items.map((x: Json) => x.id)).toContain(videoId);
  });

  it('ranks Trending by recent engagement', async () => {
    const quiet = await publishedVideo(player.token);
    await call('POST', `/v1/videos/${quiet}/view`);
    const t = await call('GET', '/v1/feed?tab=trending');
    expect(t.body.capability.status).toBe('live');
    expect(t.body.items.map((x: Json) => x.id).slice(0, 2)).toEqual([videoId, quiet]);
  });

  it('counts a view once per viewer per day', async () => {
    await call('POST', `/v1/videos/${videoId}/view`, { token: fan.token });
    await call('POST', `/v1/videos/${videoId}/view`, { token: fan.token });
    const n = await env.db.selectFrom('video_views').select(env.db.fn.countAll<string>().as('n')).where('video_id', '=', videoId).where('viewer_key', '=', fan.userId).executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(1);
  });

  it('hides a blocked player’s videos both ways', async () => {
    const blocker = await newUser('blocker', 'blocker', ['fan']);
    await call('PUT', `/v1/users/${player.userId}/block`, { token: blocker.token });
    const feed = await call('GET', '/v1/feed?limit=50', { token: blocker.token });
    expect(feed.body.items.some((x: Json) => x.owner.userId === player.userId)).toBe(false);
    expect((await call('GET', `/v1/videos/${videoId}`, { token: blocker.token })).status).toBe(404);
  });

  it('merges reports on the same video into one prioritised case', async () => {
    const r1 = await call('POST', '/v1/reports', { token: fan.token, body: { targetKind: 'video', targetId: videoId, reason: 'spam' } });
    expect(r1.status).toBe(202);
    const other = await newUser('reporter-2', 'reporter_two', ['fan']);
    await call('POST', '/v1/reports', { token: other.token, body: { targetKind: 'video', targetId: videoId, reason: 'violence' } });
    const cases = await env.db.selectFrom('moderation_cases').selectAll().where('target_id', '=', videoId).execute();
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ source: 'report', report_count: 2, priority: 1, status: 'open' });
    expect(cases[0]!.categories.sort()).toEqual(['spam', 'violence']);
    expect((await call('POST', '/v1/reports', { token: fan.token, body: { targetKind: 'video', targetId: crypto.randomUUID(), reason: 'spam' } })).status).toBe(404);
  });
});

// -------------------------------------------------------------------------------------------- admin
describe('admin and moderation', () => {
  let admin: User;
  let moderator: User;
  let player: User;
  beforeAll(async () => {
    admin = await staff('admin-1', 'admin_one', 'admin');
    moderator = await staff('mod-1', 'mod_one', 'moderator');
    player = await newUser('player-mod', 'mod_player');
  });

  it('keeps every admin route away from ordinary users and staff without MFA', async () => {
    const routes = ['/v1/admin/stats', '/v1/admin/moderation-cases', '/v1/admin/verification-requests', '/v1/admin/audit-logs'];
    for (const r of routes) {
      expect((await call('GET', r)).status).toBe(401);
      expect((await call('GET', r, { token: player.token })).status).toBe(403);
    }
    const noMfa = await staff('admin-nomfa', 'admin_nomfa', 'admin', false);
    expect((await call('GET', '/v1/admin/stats', { token: noMfa.token })).body.code).toBe('MFA_REQUIRED');
    // Moderators run the queue but cannot decide verifications or read the audit log.
    expect((await call('GET', '/v1/admin/moderation-cases', { token: moderator.token })).status).toBe(200);
    expect((await call('GET', '/v1/admin/verification-requests', { token: moderator.token })).status).toBe(403);
    expect((await call('GET', '/v1/admin/audit-logs', { token: moderator.token })).status).toBe(403);
  });

  it('lets a moderator review a flagged video and publish it, notifying the player and logging it', async () => {
    const id = await uploadedVideo(player.token);
    await workerFinishes(id, 'review_required');
    const queue = await call('GET', '/v1/admin/moderation-cases', { token: moderator.token });
    const c = queue.body.items.find((x: Json) => x.targetId === id);
    expect(c).toMatchObject({ source: 'ai', categories: ['non_football'], video: { id, status: 'review_required', moderation: 'flagged' } });
    expect((await call('POST', `/v1/admin/moderation-cases/${c.id}/decision`, { token: moderator.token, body: { decision: 'approve', note: 'futsal, fine' } })).status).toBe(204);
    expect((await call('GET', `/v1/videos/${id}`)).body.status).toBe('published');
    expect((await call('POST', `/v1/admin/moderation-cases/${c.id}/decision`, { token: moderator.token, body: { decision: 'reject' } })).body.code).toBe('CASE_CLOSED');
    const notes = await call('GET', '/v1/notifications', { token: player.token });
    expect(notes.body.items[0].kind).toBe('video.published');
    const log = await call('GET', `/v1/admin/audit-logs?targetId=${id}`, { token: admin.token });
    expect(log.body.items.map((e: Json) => e.action)).toContain('moderation.approve');
  });

  it('lets an admin review a report and remove the video', async () => {
    const id = await publishedVideo(player.token);
    const reporter = await newUser('rep-admin', 'rep_admin', ['fan']);
    await call('POST', '/v1/reports', { token: reporter.token, body: { targetKind: 'video', targetId: id, reason: 'stolen_video', details: 'this is my clip' } });
    const c = (await call('GET', '/v1/admin/moderation-cases', { token: admin.token })).body.items.find((x: Json) => x.targetId === id);
    expect(c).toMatchObject({ source: 'report', reportCount: 1 });
    await call('POST', `/v1/admin/moderation-cases/${c.id}/decision`, { token: admin.token, body: { decision: 'remove' } });
    expect((await call('GET', `/v1/videos/${id}`)).status).toBe(404);
    const report = await env.db.selectFrom('reports').select('status').where('target_id', '=', id).executeTakeFirstOrThrow();
    expect(report.status).toBe('actioned');
  });

  it('escalates and suspends', async () => {
    const id = await publishedVideo(player.token);
    const reporter = await newUser('rep-esc', 'rep_esc', ['fan']);
    await call('POST', '/v1/reports', { token: reporter.token, body: { targetKind: 'video', targetId: id, reason: 'scam' } });
    const c = (await call('GET', '/v1/admin/moderation-cases', { token: moderator.token })).body.items.find((x: Json) => x.targetId === id);
    await call('POST', `/v1/admin/moderation-cases/${c.id}/decision`, { token: moderator.token, body: { decision: 'escalate' } });
    const escalated = (await call('GET', '/v1/admin/moderation-cases', { token: moderator.token })).body.items.find((x: Json) => x.id === c.id);
    expect(escalated).toMatchObject({ priority: 0, status: 'open' });
    await call('POST', `/v1/admin/moderation-cases/${c.id}/decision`, { token: moderator.token, body: { decision: 'suspend' } });
    expect((await call('GET', '/v1/me', { token: player.token })).body.status).toBe('suspended');
    expect((await startUpload(player.token)).body.code).toBe('ACCOUNT_INACTIVE');
    expect((await call('GET', '/v1/profiles/mod_player')).status).toBe(404);
    expect((await call('POST', `/v1/admin/users/${player.userId}/status`, { token: moderator.token, body: { status: 'active', reason: 'appeal upheld' } })).status).toBe(204);
    expect((await call('GET', '/v1/me', { token: player.token })).body.status).toBe('active');
    expect((await call('POST', `/v1/admin/users/${admin.userId}/status`, { token: moderator.token, body: { status: 'suspended', reason: 'nope' } })).status).toBe(403);
  });

  it('keeps the audit log append-only', async () => {
    await expect(sql`UPDATE audit_logs SET action = 'x'`.execute(env.db)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_logs`.execute(env.db)).rejects.toThrow(/append-only/);
  });

  it('reports platform counters', async () => {
    const s = await call('GET', '/v1/admin/stats', { token: admin.token });
    expect(s.status).toBe(200);
    expect(s.body.players).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------------------------- scouts
describe('scout mode', () => {
  let admin: User;
  let scout: User;
  let otherScout: User;
  let winger: User;
  let hidden: User;

  beforeAll(async () => {
    admin = await staff('admin-scout', 'admin_scout', 'admin');
    const s = await registerUser('scout-1', { ...adult('scout_one', ['fan']), scoutApplication: { organization: 'Nile FC Academy', evidence: 'Head of youth recruitment, Nile FC' } });
    scout = { token: s.token, userId: s.userId };
    otherScout = await newUser('scout-2', 'scout_two', ['fan']);
    await env.db.insertInto('user_roles').values({ user_id: otherScout.userId, role: 'scout' }).execute();
    winger = await newUser('winger-1', 'left_winger');
    await call('PATCH', `/v1/profiles/${winger.userId}`, { token: winger.token, body: { regionCode: 'EG', player: { primaryPosition: 'LW', preferredFoot: 'left' } } });
    await publishedVideo(winger.token);
    hidden = await newUser('hidden-1', 'hidden_player');
    await call('PATCH', `/v1/profiles/${hidden.userId}`, { token: hidden.token, body: { player: { primaryPosition: 'LW', preferredFoot: 'left' } } });
    await env.db.updateTable('privacy_settings').set({ profile_visibility: 'private' }).where('user_id', '=', hidden.userId).execute();
  });

  it('becomes a scout only when an admin approves the application', async () => {
    expect((await call('GET', '/v1/scout/players', { token: scout.token })).body.code).toBe('SCOUT_VERIFICATION_REQUIRED');
    const pending = await call('GET', '/v1/admin/verification-requests', { token: admin.token });
    const req = pending.body.items.find((r: Json) => r.user.userId === scout.userId);
    expect(req).toMatchObject({ kind: 'scout', organization: 'Nile FC Academy' });
    expect((await call('POST', `/v1/admin/verification-requests/${req.id}/decision`, { token: admin.token, body: { approve: true } })).status).toBe(204);
    const me = await call('GET', '/v1/me', { token: scout.token });
    expect(me.body).toMatchObject({ roles: expect.arrayContaining(['fan', 'scout']), scoutApplication: 'approved', profile: { verified: true } });
  });

  it('searches and filters players, never returning private profiles', async () => {
    const r = await call('GET', '/v1/scout/players?position=LW&foot=left&country=EG&skill=dribbling&ageGroup=adult', { token: scout.token });
    expect(r.status).toBe(200);
    expect(r.body.items.map((p: Json) => p.handle)).toEqual(['left_winger']);
    expect(r.body.items[0]).toMatchObject({ position: 'LW', foot: 'left', country: 'EG', ageGroup: 'adult', videos: 1, topSkills: ['dribbling', 'elastico'] });
    const all = await call('GET', '/v1/scout/players?position=LW&limit=50', { token: scout.token });
    expect(all.body.items.map((p: Json) => p.handle)).not.toContain('hidden_player');
    expect((await call('GET', '/v1/scout/players', { token: winger.token })).status).toBe(403);
  });

  it('builds shortlists with private notes', async () => {
    const list = await call('POST', '/v1/scout/shortlists', { token: scout.token, body: { name: 'Egypt U23 Wingers' } });
    expect(list.status).toBe(201);
    expect((await call('PUT', `/v1/scout/shortlists/${list.body.id}/players/${winger.userId}`, { token: scout.token })).status).toBe(204);
    // Private players cannot be shortlisted or noted.
    expect((await call('PUT', `/v1/scout/shortlists/${list.body.id}/players/${hidden.userId}`, { token: scout.token })).status).toBe(404);
    expect((await call('POST', `/v1/scout/players/${hidden.userId}/notes`, { token: scout.token, body: { body: 'x' } })).status).toBe(404);
    const detail = await call('GET', `/v1/scout/shortlists/${list.body.id}`, { token: scout.token });
    expect(detail.body).toMatchObject({ name: 'Egypt U23 Wingers', players: 1, items: [{ handle: 'left_winger' }] });

    const note = await call('POST', `/v1/scout/players/${winger.userId}/notes`, { token: scout.token, body: { body: 'Quick feet, weak right foot. Watch again.' } });
    expect(note.status).toBe(201);
    expect((await call('GET', `/v1/scout/players/${winger.userId}/notes`, { token: scout.token })).body.items).toHaveLength(1);
    // Notes and shortlists are private to the scout who made them.
    expect((await call('GET', `/v1/scout/players/${winger.userId}/notes`, { token: otherScout.token })).body.items).toEqual([]);
    expect((await call('GET', `/v1/scout/shortlists/${list.body.id}`, { token: otherScout.token })).status).toBe(404);
    expect((await call('DELETE', `/v1/scout/notes/${note.body.id}`, { token: otherScout.token })).status).toBe(404);
    expect((await call('GET', `/v1/scout/players/${winger.userId}/notes`, { token: winger.token })).status).toBe(403);

    expect((await call('DELETE', `/v1/scout/shortlists/${list.body.id}/players/${winger.userId}`, { token: scout.token })).status).toBe(204);
    expect((await call('GET', `/v1/scout/shortlists`, { token: scout.token })).body.items).toMatchObject([{ players: 0 }]);
  });

  it('cannot see private data', async () => {
    const p = await call('GET', '/v1/profiles/left_winger', { token: scout.token });
    expect(p.body.email).toBeNull();
    expect(p.body.region.city).toBeNull();
    expect((await call('GET', '/v1/profiles/hidden_player', { token: scout.token })).status).toBe(404);
    expect((await call('GET', `/v1/users/${winger.userId}/consents`, { token: scout.token })).status).toBe(403);
  });

  it('asks an adult player for contact only when they allow it, and tells the scout the answer', async () => {
    const msg = { message: 'Would you be open to a trial with Nile FC next month?' };
    expect((await call('POST', `/v1/scout/players/${winger.userId}/contact`, { token: scout.token, body: msg })).body.code).toBe('CONTACT_NOT_ALLOWED');
    await grant(winger.token, winger.userId, 'scout_contact');
    expect((await call('POST', `/v1/scout/players/${winger.userId}/contact`, { token: scout.token, body: msg })).status).toBe(202);
    expect((await call('POST', `/v1/scout/players/${winger.userId}/contact`, { token: scout.token, body: msg })).body.code).toBe('ALREADY_REQUESTED');
    const incoming = await call('GET', '/v1/contact-requests', { token: winger.token });
    expect(incoming.body.items).toMatchObject([{ viaGuardian: false, scout: { handle: 'scout_one', organization: 'Nile FC Academy' } }]);
    await call('POST', `/v1/contact-requests/${incoming.body.items[0].id}/respond`, { token: winger.token, body: { accept: true } });
    const out = await call('GET', '/v1/contact-requests?direction=outgoing', { token: scout.token });
    expect(out.body.items[0].status).toBe('accepted');
    expect((await call('GET', '/v1/notifications', { token: scout.token })).body.items.map((n: Json) => n.kind)).toContain('contact.accepted');
  });
});

// -------------------------------------------------------------------------------------------- discovery
describe('search, discover, Talent Radar and challenges', () => {
  let admin: User;
  let star: User;
  let fans: User[];
  let starVideo: string;

  beforeAll(async () => {
    admin = await staff('admin-disc', 'admin_disc', 'admin');
    star = await newUser('star-1', 'nutmeg_king');
    await call('PATCH', `/v1/profiles/${star.userId}`, { token: star.token, body: { regionCode: 'EG', player: { primaryPosition: 'AM', preferredFoot: 'right' } } });
    starVideo = await publishedVideo(star.token, { title: 'Nutmeg through two defenders', skillKey: 'nutmeg', hashtags: ['nutmegchallenge'] });
    await publishedVideo(star.token, { title: 'Another nutmeg', skillKey: 'nutmeg' });
    fans = [];
    for (let i = 0; i < 6; i++) fans.push(await newUser(`radar-fan-${i}`, `radar_fan_${i}`, ['fan']));
    for (const f of fans) {
      await call('PUT', `/v1/videos/${starVideo}/like`, { token: f.token });
      await call('PUT', `/v1/users/${star.userId}/follow`, { token: f.token });
    }
  });

  it('searches by handle, title, hashtag and skill', async () => {
    expect((await call('GET', '/v1/search?q=nutmeg_k&type=players')).body.players.map((p: Json) => p.handle)).toEqual(['nutmeg_king']);
    expect((await call('GET', '/v1/search?q=defenders&type=videos')).body.videos.map((v: Json) => v.id)).toEqual([starVideo]);
    expect((await call('GET', '/v1/search?hashtag=%23NutmegChallenge')).body.videos.map((v: Json) => v.id)).toEqual([starVideo]);
    expect((await call('GET', '/v1/search?q=nutmegch&type=hashtags')).body.hashtags).toEqual([{ tag: 'nutmegchallenge', videos: 1 }]);
    const bySkill = await call('GET', '/v1/search?skill=nutmeg&type=players');
    expect(bySkill.body.players.map((p: Json) => p.handle)).toContain('nutmeg_king');
    expect((await call('GET', '/v1/search?skill=goalkeeping&type=players')).body.players).toEqual([]);
    // Wildcards are treated as text.
    expect((await call('GET', '/v1/search?q=%25&type=players')).body.players).toEqual([]);
  });

  it('puts a fast-rising player on Talent Radar with the reasons, never a rating', async () => {
    const r = await call('GET', '/v1/radar');
    expect(r.body.disclaimer.en).toMatch(/not a judgment of ability/);
    const entry = r.body.items.find((e: Json) => e.player.handle === 'nutmeg_king');
    expect(entry.reasons.map((x: Json) => x.code)).toEqual(['likes_up', 'followers_growing', 'new_player_rising', 'skill_focus']);
    expect(entry.reasons[0].text.en).toBe('Likes up 100% this week');
    expect(JSON.stringify(entry)).not.toMatch(/score|rating|potential/i);
    expect((await call('GET', '/v1/radar?skill=goalkeeping')).body.items).toEqual([]);
    const gems = await call('GET', '/v1/radar?category=hidden_gems');
    expect(gems.body.category).toBe('hidden_gems');
  });

  it('builds the Discover page', async () => {
    const d = await call('GET', '/v1/discover');
    expect(d.status).toBe(200);
    expect(d.body.skills).toHaveLength(20);
    expect(d.body.skills.find((s: Json) => s.key === 'nutmeg').videos).toBeGreaterThanOrEqual(2);
    expect(d.body.trendingHashtags.map((h: Json) => h.tag)).toContain('nutmegchallenge');
    expect(d.body.risingPlayers.map((p: Json) => p.handle)).toContain('nutmeg_king');
  });

  it('runs a challenge: admin creates it, players enter, entries are listed', async () => {
    const body = {
      slug: 'elastico-challenge', title: { en: '#ElasticoChallenge', ar: '#تحدي_الإلاستيكو' }, description: { en: 'Show your best elastico.', ar: 'أرنا أفضل إلاستيكو لديك.' },
      skillKey: 'elastico', hashtag: 'elasticochallenge', startsAt: new Date(Date.now() - 3600_000).toISOString(), endsAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    };
    expect((await call('POST', '/v1/admin/challenges', { token: star.token, body })).status).toBe(403);
    const created = await call('POST', '/v1/admin/challenges', { token: admin.token, body });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: 'active', entries: 0, isDemo: false });
    // Upload straight into the challenge, and enter an existing video.
    const direct = await publishedVideo(star.token, { challengeId: created.body.id });
    expect((await call('POST', '/v1/challenges/elastico-challenge/entries', { token: star.token, body: { videoId: starVideo } })).status).toBe(204);
    expect((await call('POST', '/v1/challenges/elastico-challenge/entries', { token: star.token, body: { videoId: starVideo } })).body.code).toBe('ALREADY_ENTERED');
    expect((await call('POST', '/v1/challenges/elastico-challenge/entries', { token: fans[0]!.token, body: { videoId: starVideo } })).status).toBe(403);
    const entries = await call('GET', '/v1/challenges/elastico-challenge/entries');
    expect(entries.body.items.map((v: Json) => v.id).sort()).toEqual([direct, starVideo].sort());
    expect((await call('GET', '/v1/challenges')).body.items[0]).toMatchObject({ slug: 'elastico-challenge', entries: 2 });
  });

  it('lists the skill taxonomy in English and Arabic', async () => {
    const s = await call('GET', '/v1/skills');
    expect(s.body.items).toHaveLength(20);
    expect(s.body.items[0]).toEqual({ key: 'dribbling', category: 'dribbling', name: { en: 'Dribbling', ar: 'المراوغة' } });
  });

  it('publishes an OpenAPI document covering the routes', async () => {
    const doc = await call('GET', '/v1/openapi.json');
    expect(doc.body.info.title).toBe('KICKSCOUT API');
    expect(Object.keys(doc.body.paths)).toEqual(expect.arrayContaining(['/v1/radar', '/v1/scout/shortlists/{shortlistId}', '/v1/admin/moderation-cases/{caseId}/decision']));
  });
});

// -------------------------------------------------------------------------------------------- demo data
describe('demo seed', () => {
  it('creates labelled demo players, clips and challenges once', async () => {
    const { seed } = await import('../src/seed.js');
    const url = process.env.__TEST_DB_URL__;
    expect(url).toBeTruthy();
    expect((await seed(url!, Buffer.alloc(32, 1))).created).toBe(true);
    expect((await seed(url!, Buffer.alloc(32, 1))).created).toBe(false);
    const p = await call('GET', '/v1/profiles/demo_winger_eg');
    expect(p.body).toMatchObject({ isDemo: true, player: { primaryPosition: 'LW' } });
    const v = await call('GET', '/v1/profiles/demo_winger_eg/videos');
    expect(v.body.items[0]).toMatchObject({ owner: { isDemo: true }, playbackUrl: expect.stringMatching(/^https:\/\/cdn\.test\/promo\/\d\d_.+\.mp4$/) });
    expect(v.body.items.every((x: Json) => x.tags.every((t: Json) => t.source === 'user'))).toBe(true);
    const ch = await call('GET', '/v1/challenges/freestyle-challenge');
    expect(ch.body.isDemo).toBe(true);
  });
});
