import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv } from './helpers.js';
import type { TestEnv } from './helpers.js';

/**
 * KICKSCOUT Guardian on the API side: what the worker decided is enforced here (nothing unapproved
 * is visible), and people review, appeal and report. The scan itself is tested in apps/worker.
 */

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

let n = 0;
async function newUser(roles = ['player']): Promise<User> {
  const sub = `g-${++n}`;
  const token = await env.token(sub);
  const res = await call('POST', '/v1/onboarding/register', { token, body: { handle: `guard_${n}`, displayName: `G ${n}`, dob: '1995-04-02', countryCode: 'EG', roles } });
  expect(res.status).toBe(201);
  return { token, userId: res.body.userId };
}

async function staff(role: 'admin' | 'moderator'): Promise<User> {
  const u = await newUser(['fan']);
  await env.db.insertInto('user_roles').values({ user_id: u.userId, role }).execute();
  return { userId: u.userId, token: await env.token(`g-${n}`, { amr: [{ method: 'totp' }], aal: 'aal2' }) };
}

async function uploaded(token: string, extra: Json = {}) {
  const created = await call('POST', '/v1/uploads', { token, body: { contentType: 'video/mp4', sizeBytes: 1000, title: 'Rainbow flick', hashtags: ['skills'], rightsConfirmed: true, ...extra } });
  expect(created.status).toBe(201);
  const videoId = created.body.videoId as string;
  env.storage.objects.set(new URL(created.body.upload.url).pathname.slice(1), { sizeBytes: 1000, contentType: 'video/mp4' });
  expect((await call('POST', `/v1/uploads/${videoId}/complete`, { token })).status).toBe(200);
  return videoId;
}

/** Stands in for the worker's Guardian scan (tested in apps/worker). */
async function scanned(videoId: string, decision: 'APPROVED' | 'REJECTED' | 'HUMAN_REVIEW', categories: string[] = []) {
  const status = decision === 'APPROVED' ? 'published' : decision === 'REJECTED' ? 'rejected' : 'review_required';
  await env.db.updateTable('videos').set({
    status, safety_status: decision, moderation: decision === 'APPROVED' ? 'safe' : decision === 'REJECTED' ? 'rejected' : 'flagged',
    quarantine_playback_key: `quarantine/${videoId}/playback.mp4`, quarantine_thumbnail_key: `quarantine/${videoId}/thumb.jpg`,
    ...(decision === 'APPROVED' ? { playback_key: `playback/${videoId}.mp4`, thumbnail_key: `thumbs/${videoId}.jpg`, published_at: new Date() } : {}),
    duration_ms: 9000, safety_checked_at: new Date(),
  }).where('id', '=', videoId).execute();
  const resultId = crypto.randomUUID();
  await env.db.insertInto('video_moderation_results').values({
    id: resultId, video_id: videoId, scan_kind: 'upload', football_relevance_score: decision === 'APPROVED' ? 0.95 : 0.4,
    safety_scores: JSON.stringify(Object.fromEntries(categories.map((c) => [c, 0.9]))), detected_categories: categories, confidence: 0.9,
    suspicious_timestamps: JSON.stringify(categories.length ? [{ atMs: 4100, categories, probability: 0.9 }] : []), frames_analyzed: 14,
    stages: ['integrity', 'duplicate', 'text', 'screen', 'deep', 'audio'], decision,
    reason_codes: decision === 'APPROVED' ? ['FOOTBALL_CONFIRMED'] : ['POSSIBLE_PROHIBITED_CONTENT'], review_required: decision === 'HUMAN_REVIEW',
    model_version: 'screen:claude-haiku-5-5;deep:claude-opus-5-5', policy_version: 'test-1', latency_ms: 4200,
  }).execute();
  if (decision === 'HUMAN_REVIEW') {
    const owner = (await env.db.selectFrom('videos').select('owner_user_id').where('id', '=', videoId).executeTakeFirstOrThrow()).owner_user_id;
    await env.db.insertInto('moderation_cases').values({
      id: crypto.randomUUID(), target_kind: 'video', target_id: videoId, source: 'ai', categories, priority: 1, user_id: owner, result_id: resultId, reason: 'POSSIBLE_PROHIBITED_CONTENT',
    }).execute();
  }
}

async function caseFor(videoId: string, token: string) {
  const list = await call('GET', '/v1/admin/moderation-cases', { token });
  return list.body.items.find((c: Json) => c.targetId === videoId) as Json | undefined;
}

const decide = (caseId: string, token: string, body: Json) => call('POST', `/v1/admin/moderation-cases/${caseId}/decision`, { token, body });
const jobsFor = async (videoId: string) =>
  (await env.db.selectFrom('jobs').select(['kind', 'payload']).execute()).filter((j) => (j.payload as Json).videoId === videoId).map((j) => `${j.kind}:${(j.payload as Json).kind ?? ''}`);

let admin: User;
let moderator: User;
beforeAll(async () => {
  admin = await staff('admin');
  moderator = await staff('moderator');
});

describe('Guardian enforcement in the API', () => {
  it('keeps a held upload out of every public surface, while the owner sees its state and a private signed link', async () => {
    const player = await newUser();
    const id = await uploaded(player.token);
    await scanned(id, 'HUMAN_REVIEW', ['suggestive']);
    expect((await call('GET', `/v1/videos/${id}`)).status).toBe(404);
    expect((await call('GET', `/v1/videos/${id}`, { token: (await newUser()).token })).status).toBe(404);
    const own = await call('GET', `/v1/videos/${id}`, { token: player.token });
    expect(own.body).toMatchObject({ status: 'review_required', safetyStatus: 'HUMAN_REVIEW', playbackUrl: null, canAppeal: false });
    expect(own.body.privatePlaybackUrl).toMatch(/^https:\/\/storage\.test\/quarantine\/.+signed=1$/);
    const feed = await call('GET', '/v1/feed?tab=new_talent');
    expect(feed.body.items.map((v: Json) => v.id)).not.toContain(id);
    // the public never sees the safety state
    const published = await uploaded(player.token);
    await scanned(published, 'APPROVED');
    const pub = await call('GET', `/v1/videos/${published}`);
    expect(pub.body).toMatchObject({ status: 'published', safetyStatus: null, privatePlaybackUrl: null });
  });

  it('a paid plan or any account state does not lift an upload restriction', async () => {
    const player = await newUser();
    await env.db.insertInto('subscriptions').values({
      id: crypto.randomUUID(), user_id: player.userId, plan_key: 'player_pro', provider: 'stripe', provider_subscription_id: `sub_${crypto.randomUUID()}`, status: 'active', provider_event_at: new Date(),
    }).execute();
    await env.db.updateTable('users').set({ upload_restricted_until: new Date(Date.now() + 86_400_000), upload_restriction_reason: 'Repeated community rule violations' }).where('id', '=', player.userId).execute();
    const r = await call('POST', '/v1/uploads', { token: player.token, body: { contentType: 'video/mp4', sizeBytes: 1000, title: 'x', hashtags: [], rightsConfirmed: true } });
    expect(r).toMatchObject({ status: 403, body: { code: 'UPLOADS_RESTRICTED' } });
  });

  it('shows reviewers the Guardian evidence, gives an audited signed preview, and refuses to dismiss a held upload', async () => {
    const player = await newUser();
    const id = await uploaded(player.token);
    await scanned(id, 'HUMAN_REVIEW', ['nudity']);
    const c = (await caseFor(id, moderator.token))!;
    expect(c).toMatchObject({ source: 'ai', restricted: false, reason: 'POSSIBLE_PROHIBITED_CONTENT', video: { id, playbackUrl: null } });
    expect(c.guardian).toMatchObject({
      safetyStatus: 'HUMAN_REVIEW', legalHold: false,
      scans: [{ decision: 'HUMAN_REVIEW', detectedCategories: ['nudity'], footballRelevance: 0.4, suspiciousTimestamps: [{ atMs: 4100 }], modelVersion: expect.stringContaining('deep:'), policyVersion: 'test-1' }],
      owner: { userId: player.userId, activeStrikes: [], uploadRestrictedUntil: null },
    });
    const preview = await call('GET', `/v1/admin/moderation-cases/${c.id}/preview`, { token: moderator.token });
    expect(preview.status).toBe(200);
    expect(preview.body.playbackUrl).toContain(`quarantine/${id}/playback.mp4`);
    const audit = await env.db.selectFrom('moderation_audit_logs').selectAll().where('case_id', '=', c.id).execute();
    expect(audit.map((a) => a.action)).toContain('moderation.preview');
    expect((await decide(c.id, moderator.token, { decision: 'dismiss' })).body.code).toBe('DECISION_REQUIRED');
    expect((await call('GET', `/v1/admin/moderation-cases/${c.id}/preview`, { token: player.token })).status).toBe(403);
  });

  it('approving publishes through the worker from the private copy, never directly', async () => {
    const player = await newUser();
    const id = await uploaded(player.token);
    await scanned(id, 'HUMAN_REVIEW', ['suggestive']);
    const c = (await caseFor(id, moderator.token))!;
    expect((await decide(c.id, moderator.token, { decision: 'approve', note: 'goal celebration' })).status).toBe(204);
    const v = await env.db.selectFrom('videos').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(v).toMatchObject({ safety_status: 'APPROVED', status: 'review_required' });
    expect(await jobsFor(id)).toContain('video.publish:');
    const audit = await env.db.selectFrom('moderation_audit_logs').selectAll().where('case_id', '=', c.id).execute();
    expect(audit.map((a) => a.action)).toContain('moderation.approve');
  });

  it('a rejection records a reviewer strike; the player appeals once; overturning voids the strike and republishes', async () => {
    const player = await newUser();
    const id = await uploaded(player.token);
    await scanned(id, 'HUMAN_REVIEW', ['nudity']);
    const c = (await caseFor(id, moderator.token))!;
    expect((await decide(c.id, moderator.token, { decision: 'reject' })).status).toBe(204);
    const strikes = await env.db.selectFrom('account_strikes').selectAll().where('user_id', '=', player.userId).execute();
    expect(strikes).toEqual([expect.objectContaining({ category: 'nudity', severity: 'serious', source: 'reviewer', video_id: id, case_id: c.id })]);
    const restricted = await env.db.selectFrom('users').select('upload_restricted_until').where('id', '=', player.userId).executeTakeFirstOrThrow();
    expect(restricted.upload_restricted_until!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    const own = await call('GET', `/v1/videos/${id}`, { token: player.token });
    expect(own.body).toMatchObject({ status: 'rejected', safetyStatus: 'REJECTED', canAppeal: true });
    expect((await call('POST', `/v1/videos/${id}/appeal`, { token: player.token, body: { explanation: 'short' } })).status).toBe(400);
    const appeal = await call('POST', `/v1/videos/${id}/appeal`, { token: player.token, body: { explanation: 'This is a goalkeeper drill in my club kit.' } });
    expect(appeal).toMatchObject({ status: 201, body: { status: 'pending', videoId: id } });
    expect((await call('POST', `/v1/videos/${id}/appeal`, { token: player.token, body: { explanation: 'Again, please look at it.' } })).body.code).toBe('APPEAL_PENDING');
    expect((await call('POST', `/v1/videos/${id}/appeal`, { token: (await newUser()).token, body: { explanation: 'Not my video at all.' } })).status).toBe(404);
    expect((await call('GET', `/v1/videos/${id}`, { token: player.token })).body.canAppeal).toBe(false);

    const ac = (await caseFor(id, admin.token))!;
    expect(ac).toMatchObject({ source: 'appeal', guardian: { appeal: { status: 'pending' }, previousDecisions: [{ decision: 'reject' }] } });
    expect((await decide(ac.id, admin.token, { decision: 'approve', note: 'kit, not nudity' })).status).toBe(204);
    expect(await env.db.selectFrom('moderation_appeals').select(['status', 'decided_by']).where('video_id', '=', id).executeTakeFirstOrThrow()).toEqual({ status: 'overturned', decided_by: admin.userId });
    expect((await env.db.selectFrom('account_strikes').select('voided_at').where('video_id', '=', id).executeTakeFirstOrThrow()).voided_at).toBeInstanceOf(Date);
    expect(await jobsFor(id)).toContain('video.publish:');
    const notes = await env.db.selectFrom('notifications').select('kind').where('user_id', '=', player.userId).execute();
    expect(notes.map((x) => x.kind)).toEqual(expect.arrayContaining(['video.rejected', 'video.appeal_decided']));
  });

  it('pulls a published video after enough distinct reports, and re-scans it', async () => {
    const player = await newUser();
    const id = await uploaded(player.token);
    await scanned(id, 'APPROVED');
    for (let i = 0; i < 2; i++) await call('POST', '/v1/reports', { token: (await newUser(['fan'])).token, body: { targetKind: 'video', targetId: id, reason: 'spam' } });
    expect((await call('GET', `/v1/videos/${id}`)).status).toBe(200);
    expect((await jobsFor(id)).filter((j) => j !== 'video.process:')).toEqual(['video.rescan:report']); // the first report already asked for a fresh scan
    await call('POST', '/v1/reports', { token: (await newUser(['fan'])).token, body: { targetKind: 'video', targetId: id, reason: 'not_football' } });
    expect((await call('GET', `/v1/videos/${id}`)).status).toBe(404);
    expect(await env.db.selectFrom('videos').select(['status', 'safety_status']).where('id', '=', id).executeTakeFirstOrThrow()).toEqual({ status: 'review_required', safety_status: 'HUMAN_REVIEW' });
    expect(await jobsFor(id)).toEqual(expect.arrayContaining(['video.unpublish:', 'video.rescan:report']));
  });

  it('a child-safety report takes the video down at once into an admin-only case', async () => {
    const player = await newUser();
    const id = await uploaded(player.token);
    await scanned(id, 'APPROVED');
    await call('POST', '/v1/reports', { token: (await newUser(['fan'])).token, body: { targetKind: 'video', targetId: id, reason: 'child_safety' } });
    expect((await call('GET', `/v1/videos/${id}`)).status).toBe(404);
    expect(await caseFor(id, moderator.token)).toBeUndefined();
    const c = (await caseFor(id, admin.token))!;
    expect(c).toMatchObject({ restricted: true, priority: 0, video: { playbackUrl: null, thumbnailUrl: null } });
    expect((await decide(c.id, moderator.token, { decision: 'approve' })).status).toBe(404);
  });

  it('escalate_safety: legal hold, no preview, admins only, uploads paused', async () => {
    const player = await newUser();
    const id = await uploaded(player.token);
    await scanned(id, 'HUMAN_REVIEW', ['suggestive']);
    const c = (await caseFor(id, moderator.token))!;
    expect((await decide(c.id, moderator.token, { decision: 'escalate_safety', note: 'possible minor' })).status).toBe(204);
    expect(await caseFor(id, moderator.token)).toBeUndefined();
    expect((await env.db.selectFrom('videos').select('legal_hold').where('id', '=', id).executeTakeFirstOrThrow()).legal_hold).toBe(true);
    expect((await call('GET', `/v1/admin/moderation-cases/${c.id}/preview`, { token: admin.token })).body.code).toBe('LEGAL_HOLD');
    expect((await call('POST', `/v1/admin/videos/${id}/rescan`, { token: admin.token })).body.code).toBe('LEGAL_HOLD');
    expect((await call('GET', `/v1/videos/${id}`, { token: player.token })).body.privatePlaybackUrl).toBeNull();
    const u = await env.db.selectFrom('users').select(['upload_restricted_until', 'upload_restriction_reason']).where('id', '=', player.userId).executeTakeFirstOrThrow();
    expect(u.upload_restriction_reason).toBe('Safety investigation');
  });

  it('restrict_uploads, request_review and assign keep the case open and are audited', async () => {
    const player = await newUser();
    const id = await uploaded(player.token);
    await scanned(id, 'HUMAN_REVIEW', ['spam']);
    const c = (await caseFor(id, moderator.token))!;
    expect((await decide(c.id, moderator.token, { decision: 'assign' })).status).toBe(204);
    expect((await caseFor(id, moderator.token))!.assignedReviewer).toBe(moderator.userId);
    expect((await decide(c.id, moderator.token, { decision: 'restrict_uploads', days: 3 })).status).toBe(204);
    const u = await env.db.selectFrom('users').select('upload_restricted_until').where('id', '=', player.userId).executeTakeFirstOrThrow();
    expect(u.upload_restricted_until!.getTime()).toBeGreaterThan(Date.now() + 2.9 * 86_400_000);
    expect((await decide(c.id, moderator.token, { decision: 'request_review' })).status).toBe(204);
    expect(await jobsFor(id)).toContain('video.rescan:rescan');
    const still = (await caseFor(id, moderator.token))!;
    expect(still).toMatchObject({ status: 'open', assignedReviewer: null });
    const audit = await env.db.selectFrom('moderation_audit_logs').select('action').where('case_id', '=', c.id).execute();
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['moderation.assign', 'moderation.restrict_uploads', 'moderation.request_review']));
  });

  it('re-checks a published clip whose title or hashtags change', async () => {
    const player = await newUser();
    const id = await uploaded(player.token);
    await scanned(id, 'APPROVED');
    await call('PATCH', `/v1/videos/${id}`, { token: player.token, body: { title: 'New title' } });
    expect(await jobsFor(id)).toContain('video.rescan:rescan');
  });

  it('queues a policy re-scan of published videos and reports quality metrics', async () => {
    const queued = await call('POST', '/v1/admin/guardian/rescan', { token: admin.token, body: { policyVersion: 'test-2', limit: 1000 } });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBeGreaterThan(0);
    expect((await call('POST', '/v1/admin/guardian/rescan', { token: moderator.token, body: { policyVersion: 'test-2' } })).status).toBe(403);
    const m = await call('GET', '/v1/admin/guardian/metrics?days=7', { token: moderator.token });
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ days: 7, policyVersions: ['test-1'], reviewed: { approved: expect.any(Number), rejected: expect.any(Number) } });
    expect(m.body.uploadsScanned).toBeGreaterThan(0);
    expect(m.body.decisions.APPROVED).toBeGreaterThan(0);
    expect(m.body.humanReviewRate).toBeGreaterThan(0);
    expect(JSON.stringify(m.body)).not.toMatch(/accuracy.*1\.0|100%/);
  });
});
