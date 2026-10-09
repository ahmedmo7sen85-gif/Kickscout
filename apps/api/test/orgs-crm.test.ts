import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSavedSearchAlerts } from '@fp/worker/alerts';
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
type User = { token: string; userId: string; email?: string };

async function call(method: string, url: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await env.app.inject({ method: method as 'GET', url, headers, ...(opts.body !== undefined ? { payload: opts.body as Json } : {}) });
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Json };
}

const adult = (handle: string, roles = ['player']) => ({ handle, displayName: handle, dob: '1995-04-02', countryCode: 'EG', roles });

/** Registers with a verified email (needed to accept organization invitations). */
async function newUser(handle: string, roles = ['player'], opts: { scout?: boolean } = {}): Promise<User> {
  const email = `${handle}@example.com`;
  const token = await env.token(`sub-${handle}`, { email, email_verified: true });
  const res = await call('POST', '/v1/onboarding/register', { token, body: adult(handle, roles) });
  expect(res.status).toBe(201);
  if (opts.scout) await env.db.insertInto('user_roles').values({ user_id: res.body.userId, role: 'scout' }).execute();
  return { token, userId: res.body.userId, email };
}

async function staffAdmin(handle: string): Promise<User> {
  const u = await newUser(handle, ['fan']);
  await env.db.insertInto('user_roles').values({ user_id: u.userId, role: 'admin' }).execute();
  return { ...u, token: await env.token(`sub-${handle}`, { email: u.email, email_verified: true, amr: [{ method: 'totp' }], aal: 'aal2' }) };
}

async function grant(token: string, subjectId: string, purpose: string) {
  const r = await call('POST', '/v1/consents', { token, body: { subjectId, purpose, granted: true, policyVersion: 'test-1' } });
  expect(r.status).toBe(204);
}

/** A player with a position and country, so scout filters can find them. */
async function player(handle: string, position = 'LW') {
  const u = await newUser(handle);
  await call('PATCH', `/v1/profiles/${u.userId}`, { token: u.token, body: { regionCode: 'EG', player: { primaryPosition: position, preferredFoot: 'left' } } });
  return u;
}

/** Uploads a clip and leaves it waiting for a human, as the worker does with an AI flag. */
async function clipInReview(token: string, extra: Json = {}) {
  const created = await call('POST', '/v1/uploads', { token, body: { contentType: 'video/mp4', sizeBytes: 1000, title: 'Cut inside and shoot', skillKey: 'dribbling', rightsConfirmed: true, ...extra } });
  expect(created.status).toBe(201);
  const videoId = created.body.videoId as string;
  env.storage.objects.set(new URL(created.body.upload.url).pathname.slice(1), { sizeBytes: 1000, contentType: 'video/mp4' });
  expect((await call('POST', `/v1/uploads/${videoId}/complete`, { token })).status).toBe(200);
  await env.db.updateTable('videos').set({ status: 'review_required', moderation: 'flagged', playback_key: `playback/${videoId}.mp4`, thumbnail_key: `thumbs/${videoId}.jpg`, duration_ms: 9000 })
    .where('id', '=', videoId).execute();
  await env.db.insertInto('video_skills').values({ video_id: videoId, skill_key: 'dribbling', source: 'ai', confidence: 0.9 }).execute();
  const caseId = crypto.randomUUID();
  await env.db.insertInto('moderation_cases').values({ id: caseId, target_kind: 'video', target_id: videoId, source: 'ai', categories: ['unclear'], priority: 2 }).execute();
  return { videoId, caseId };
}

async function createOrg(owner: User, name: string, type = 'academy') {
  const r = await call('POST', '/v1/orgs', { token: owner.token, body: { name, type, countryCode: 'EG' } });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

/** Invites by email and accepts with the invitee's verified email. */
async function join(orgId: string, by: User, who: User, role: string) {
  const inv = await call('POST', `/v1/orgs/${orgId}/invitations`, { token: by.token, body: { email: who.email, role } });
  expect(inv.status).toBe(201);
  const { token } = env.mailer.orgInvitations.at(-1)!;
  const acc = await call('POST', '/v1/org-invitations/accept', { token: who.token, body: { token } });
  expect(acc.status).toBe(200);
  expect(acc.body).toEqual({ organizationId: orgId, role });
}

const auditActions = async (targetId: string) =>
  (await env.db.selectFrom('audit_logs').select('action').where('target_id', '=', targetId).orderBy('id').execute()).map((r) => r.action);

// ------------------------------------------------------------------------------------------------
describe('organizations', () => {
  let owner: User;
  let admin: User;
  let invitee: User;
  let orgId: string;

  beforeAll(async () => {
    owner = await newUser('org_owner', ['fan']);
    admin = await newUser('org_admin', ['fan']);
    invitee = await newUser('org_invitee', ['fan']);
  });

  it('lets an adult found an organization and shows only its public profile to everyone else', async () => {
    orgId = await createOrg(owner, 'Nile Valley Academy');
    const pub = await call('GET', `/v1/orgs/${orgId}`);
    expect(pub.body).toEqual({ id: orgId, name: 'Nile Valley Academy', type: 'academy', country: 'EG', verified: false, logoKey: null, logoUrl: null, myRole: null });
    expect((await call('GET', `/v1/orgs/${orgId}`, { token: owner.token })).body.myRole).toBe('owner');
    expect((await call('GET', '/v1/orgs/mine', { token: owner.token })).body.items).toMatchObject([{ id: orgId, myRole: 'owner', suspended: false }]);
    // No member list for non-members.
    expect((await call('GET', `/v1/orgs/${orgId}/dashboard`, { token: invitee.token })).body.code).toBe('NOT_A_MEMBER');
    expect((await call('GET', `/v1/orgs/${orgId}/dashboard`)).status).toBe(401);
    const kidToken = await env.token('sub-org-kid', { email: 'kid@example.com', email_verified: true });
    await call('POST', '/v1/onboarding/register', { token: kidToken, body: { handle: 'org_kid', displayName: 'Kid', dob: '2011-03-15', countryCode: 'EG', roles: ['player'] } });
    // A minor is pending guardian consent, and organizations are for adults in any case.
    expect((await call('POST', '/v1/orgs', { token: kidToken, body: { name: 'Kid FC', type: 'club' } })).status).toBe(403);
    expect((await call('POST', '/v1/orgs', { token: owner.token, body: { name: 'X', type: 'club' } })).body.code).toBe('VALIDATION_FAILED');
    expect((await call('POST', '/v1/orgs', { token: owner.token, body: { name: 'Bad type', type: 'federation' } })).body.code).toBe('VALIDATION_FAILED');
  });

  it('invites by a hashed, expiring email token bound to the verified address', async () => {
    const inv = await call('POST', `/v1/orgs/${orgId}/invitations`, { token: owner.token, body: { email: admin.email, role: 'admin' } });
    expect(inv.status).toBe(201);
    const { token, to, role } = env.mailer.orgInvitations.at(-1)!;
    expect({ to, role }).toEqual({ to: admin.email, role: 'admin' });
    // Only the hash is stored.
    const row = await env.db.selectFrom('organization_invitations').selectAll().where('id', '=', inv.body.invitationId).executeTakeFirstOrThrow();
    expect(row.token_hash.toString('base64url')).not.toBe(token);
    expect(Buffer.from(row.token_hash).length).toBe(32);
    expect((await call('POST', '/v1/org-invitations/accept', { token: invitee.token, body: { token } })).body.code).toBe('EMAIL_MISMATCH');
    expect((await call('POST', '/v1/org-invitations/accept', { token: admin.token, body: { token } })).status).toBe(200);
    expect((await call('POST', '/v1/org-invitations/accept', { token: admin.token, body: { token } })).body.code).toBe('INVITATION_INVALID');
    expect((await call('GET', `/v1/orgs/${orgId}/dashboard`, { token: admin.token })).body.members.map((m: Json) => [m.handle, m.role]))
      .toEqual([['org_owner', 'owner'], ['org_admin', 'admin']]);
  });

  it('refuses an expired invitation and marks it expired; a declined one cannot be used', async () => {
    const inv = await call('POST', `/v1/orgs/${orgId}/invitations`, { token: admin.token, body: { email: invitee.email, role: 'viewer' } });
    const { token } = env.mailer.orgInvitations.at(-1)!;
    await env.db.updateTable('organization_invitations').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', inv.body.invitationId).execute();
    const r = await call('POST', '/v1/org-invitations/accept', { token: invitee.token, body: { token } });
    expect(r).toMatchObject({ status: 410, body: { code: 'INVITATION_INVALID' } });
    expect((await env.db.selectFrom('organization_invitations').select('status').where('id', '=', inv.body.invitationId).executeTakeFirstOrThrow()).status).toBe('expired');

    await call('POST', `/v1/orgs/${orgId}/invitations`, { token: admin.token, body: { email: invitee.email, role: 'viewer' } });
    const second = env.mailer.orgInvitations.at(-1)!.token;
    expect((await call('POST', '/v1/org-invitations/decline', { token: invitee.token, body: { token: second } })).status).toBe(204);
    expect((await call('POST', '/v1/org-invitations/accept', { token: invitee.token, body: { token: second } })).status).toBe(410);
  });

  it('keeps ownership out of invitations and admins away from admins', async () => {
    expect((await call('POST', `/v1/orgs/${orgId}/invitations`, { token: owner.token, body: { email: 'x@example.com', role: 'owner' } })).body.code).toBe('VALIDATION_FAILED');
    expect((await call('POST', `/v1/orgs/${orgId}/invitations`, { token: admin.token, body: { email: 'x@example.com', role: 'admin' } })).body.code).toBe('ORG_ROLE_REQUIRED');
    // Re-inviting replaces the earlier link; the admin can revoke a scout invitation.
    const a = await call('POST', `/v1/orgs/${orgId}/invitations`, { token: admin.token, body: { email: invitee.email, role: 'scout' } });
    const pending = await call('GET', `/v1/orgs/${orgId}/invitations`, { token: admin.token });
    expect(pending.body.items).toMatchObject([{ id: a.body.invitationId, email: invitee.email, role: 'scout', status: 'pending' }]);
    expect((await call('DELETE', `/v1/orgs/${orgId}/invitations/${a.body.invitationId}`, { token: admin.token })).status).toBe(204);
    const revoked = env.mailer.orgInvitations.at(-1)!.token;
    expect((await call('POST', '/v1/org-invitations/accept', { token: invitee.token, body: { token: revoked } })).status).toBe(410);
    // Members below admin see the dashboard but not invitations, and cannot invite.
    await join(orgId, admin, invitee, 'viewer');
    const asViewer = await call('GET', `/v1/orgs/${orgId}/dashboard`, { token: invitee.token });
    expect(asViewer.body).toMatchObject({ myRole: 'viewer', invitations: [], verification: { status: 'none' } });
    expect((await call('POST', `/v1/orgs/${orgId}/invitations`, { token: invitee.token, body: { email: 'y@example.com', role: 'viewer' } })).body.code).toBe('ORG_ROLE_REQUIRED');
    expect((await call('GET', `/v1/orgs/${orgId}/invitations`, { token: invitee.token })).status).toBe(403);
  });

  it('changes roles, removes and lets members leave within the role rules, auditing each change', async () => {
    expect((await call('PATCH', `/v1/orgs/${orgId}/members/${invitee.userId}`, { token: admin.token, body: { role: 'analyst' } })).status).toBe(204);
    expect((await call('PATCH', `/v1/orgs/${orgId}/members/${owner.userId}`, { token: admin.token, body: { role: 'viewer' } })).body.code).toBe('ORG_ROLE_REQUIRED');
    expect((await call('PATCH', `/v1/orgs/${orgId}/members/${admin.userId}`, { token: admin.token, body: { role: 'viewer' } })).body.code).toBe('ORG_ROLE_REQUIRED');
    expect((await call('DELETE', `/v1/orgs/${orgId}/members/${owner.userId}`, { token: admin.token })).body.code).toBe('ORG_ROLE_REQUIRED');
    expect((await call('PATCH', `/v1/orgs/${orgId}/members/${admin.userId}`, { token: invitee.token, body: { role: 'viewer' } })).body.code).toBe('ORG_ROLE_REQUIRED');
    expect((await call('POST', `/v1/orgs/${orgId}/leave`, { token: owner.token })).body.code).toBe('OWNER_MUST_TRANSFER');
    expect((await call('DELETE', `/v1/orgs/${orgId}/members/${invitee.userId}`, { token: admin.token })).status).toBe(204);
    expect((await call('GET', `/v1/orgs/${orgId}/dashboard`, { token: invitee.token })).body.code).toBe('NOT_A_MEMBER');
    expect((await call('POST', `/v1/orgs/${orgId}/leave`, { token: admin.token })).status).toBe(204);
    expect(await auditActions(orgId)).toEqual(expect.arrayContaining([
      'org.created', 'org.member_added', 'org.member_invited', 'org.invitation_accepted', 'org.invitation_declined', 'org.invitation_revoked',
      'org.member_role_changed', 'org.member_removed', 'org.member_left',
    ]));
    const notes = (await call('GET', '/v1/notifications', { token: invitee.token })).body.items.map((n: Json) => n.kind);
    expect(notes).toEqual(expect.arrayContaining(['org.role_changed', 'org.removed']));
  });

  it('transfers ownership to a member, and the old owner becomes an admin', async () => {
    await join(orgId, owner, admin, 'scout');
    expect((await call('POST', `/v1/orgs/${orgId}/transfer`, { token: admin.token, body: { userId: admin.userId } })).body.code).toBe('ORG_ROLE_REQUIRED');
    expect((await call('POST', `/v1/orgs/${orgId}/transfer`, { token: owner.token, body: { userId: invitee.userId } })).status).toBe(404);
    expect((await call('POST', `/v1/orgs/${orgId}/transfer`, { token: owner.token, body: { userId: admin.userId } })).status).toBe(204);
    const d = await call('GET', `/v1/orgs/${orgId}/dashboard`, { token: owner.token });
    expect(d.body.members.map((m: Json) => [m.handle, m.role])).toEqual([['org_owner', 'admin'], ['org_admin', 'owner']]);
    expect(await auditActions(orgId)).toContain('org.ownership_transferred');
  });

  it('passes an organization on when its owner deletes their account', async () => {
    const o = await newUser('org_leaving_owner', ['fan']);
    const a = await newUser('org_heir', ['fan']);
    const id = await createOrg(o, 'Heir Test Club', 'club');
    await join(id, o, a, 'admin');
    expect((await call('DELETE', '/v1/me', { token: o.token, body: { confirm: 'DELETE' } })).status).toBe(200);
    expect((await call('GET', `/v1/orgs/${id}/dashboard`, { token: a.token })).body.members).toMatchObject([{ handle: 'org_heir', role: 'owner' }]);
    const solo = await newUser('org_solo_owner', ['fan']);
    const soloId = await createOrg(solo, 'Solo Club', 'club');
    await call('DELETE', '/v1/me', { token: solo.token, body: { confirm: 'DELETE' } });
    expect((await call('GET', `/v1/orgs/${soloId}`)).status).toBe(404);
  });

  it('lets only the owner delete the organization, erasing its pipeline', async () => {
    const o = await newUser('org_deleter', ['fan']);
    const id = await createOrg(o, 'Short Lived FC', 'club');
    expect((await call('DELETE', `/v1/orgs/${id}`, { token: o.token, body: { confirm: 'delete' } })).body.code).toBe('VALIDATION_FAILED');
    expect((await call('DELETE', `/v1/orgs/${id}`, { token: o.token, body: { confirm: 'DELETE' } })).status).toBe(204);
    expect((await call('GET', `/v1/orgs/${id}`)).status).toBe(404);
    expect((await call('GET', '/v1/orgs/mine', { token: o.token })).body.items).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
describe('scout CRM: roles, isolation and the pipeline', () => {
  let ownerA: User; // verified scout, owner of A
  let scoutA: User; // verified scout, scout in A
  let unverifiedScoutA: User; // scout role in A but not a verified scout on the platform
  let analystA: User;
  let viewerA: User;
  let ownerB: User; // verified scout, owner of B
  let winger: User;
  let striker: User;
  let orgA: string;
  let orgB: string;
  let entryA: string;
  let entryB: string;
  let personalEntry: string;

  beforeAll(async () => {
    ownerA = await newUser('crm_owner_a', ['fan'], { scout: true });
    scoutA = await newUser('crm_scout_a', ['fan'], { scout: true });
    unverifiedScoutA = await newUser('crm_unverified_a', ['fan']);
    analystA = await newUser('crm_analyst_a', ['fan']);
    viewerA = await newUser('crm_viewer_a', ['fan']);
    ownerB = await newUser('crm_owner_b', ['fan'], { scout: true });
    winger = await player('crm_winger');
    striker = await player('crm_striker', 'ST');
    orgA = await createOrg(ownerA, 'Alpha Academy');
    orgB = await createOrg(ownerB, 'Beta Agency', 'agency');
    await join(orgA, ownerA, scoutA, 'scout');
    await join(orgA, ownerA, unverifiedScoutA, 'scout');
    await join(orgA, ownerA, analystA, 'analyst');
    await join(orgA, ownerA, viewerA, 'viewer');
  });

  it('follows the role matrix on every pipeline action', async () => {
    const add = (u: User) => call('PUT', `/v1/orgs/${orgA}/crm/players/${winger.userId}`, { token: u.token, body: { tags: ['Left Foot'] } });
    expect((await add(viewerA)).body.code).toBe('ORG_ROLE_REQUIRED');
    expect((await add(analystA)).body.code).toBe('ORG_ROLE_REQUIRED');
    expect((await add(unverifiedScoutA)).body.code).toBe('SCOUT_VERIFICATION_REQUIRED');
    const created = await add(scoutA);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ stage: 'new', tags: ['left foot'], player: { handle: 'crm_winger' }, contactRequest: null });
    entryA = created.body.id;
    // Adding again returns the same card.
    expect((await add(ownerA)).body.id).toBe(entryA);

    for (const u of [viewerA, analystA, scoutA, ownerA]) {
      const p = await call('GET', `/v1/orgs/${orgA}/crm/pipeline`, { token: u.token });
      expect(p.status).toBe(200);
      expect(p.body.items.map((i: Json) => i.id)).toEqual([entryA]);
    }
    const move = (u: User) => call('POST', `/v1/orgs/${orgA}/crm/entries/${entryA}/stage`, { token: u.token, body: { stage: 'watching' } });
    expect((await move(viewerA)).body.code).toBe('ORG_ROLE_REQUIRED');
    expect((await move(analystA)).body.code).toBe('ORG_ROLE_REQUIRED');
    expect((await move(scoutA)).body.stage).toBe('watching');

    const note = (u: User, body: string) => call('POST', `/v1/orgs/${orgA}/crm/entries/${entryA}/notes`, { token: u.token, body: { body } });
    expect((await note(viewerA, 'viewer note')).body.code).toBe('ORG_ROLE_REQUIRED');
    const n = await note(analystA, 'Strong first touch under pressure.');
    expect(n.status).toBe(201);
    expect((await note(scoutA, 'Agree, check weak foot.')).status).toBe(201);
    // Viewers read notes; only the author or an admin deletes one.
    const detail = await call('GET', `/v1/orgs/${orgA}/crm/entries/${entryA}`, { token: viewerA.token });
    expect(detail.body.notes.map((x: Json) => x.author.handle)).toEqual(['crm_scout_a', 'crm_analyst_a']);
    expect((await call('DELETE', `/v1/orgs/${orgA}/crm/notes/${n.body.id}`, { token: scoutA.token })).body.code).toBe('ORG_ROLE_REQUIRED');
    expect((await call('PATCH', `/v1/orgs/${orgA}/crm/entries/${entryA}`, { token: analystA.token, body: { tags: ['x'] } })).status).toBe(403);
    expect((await call('PATCH', `/v1/orgs/${orgA}/crm/entries/${entryA}`, { token: scoutA.token, body: { tags: ['U23', 'left foot', 'u23'] } })).body.tags).toEqual(['u23', 'left foot']);
    expect((await call('GET', `/v1/orgs/${orgA}/crm/pipeline?tag=U23`, { token: viewerA.token })).body.items).toHaveLength(1);
    expect((await call('GET', `/v1/orgs/${orgA}/crm/pipeline?stage=archived`, { token: viewerA.token })).body.items).toHaveLength(0);
  });

  it('isolates organizations: a member of B cannot read or touch A’s pipeline, notes or searches', async () => {
    const b = await call('PUT', `/v1/orgs/${orgB}/crm/players/${winger.userId}`, { token: ownerB.token, body: {} });
    entryB = b.body.id;
    await call('POST', `/v1/orgs/${orgB}/crm/entries/${entryB}/notes`, { token: ownerB.token, body: { body: 'Beta-only note' } });
    const searchA = await call('POST', `/v1/orgs/${orgA}/crm/saved-searches`, { token: scoutA.token, body: { name: 'Alpha wingers', filters: { position: 'LW' } } });
    expect(searchA.status).toBe(201);

    for (const path of ['crm/pipeline', `crm/entries/${entryA}`, 'crm/saved-searches', 'dashboard']) {
      expect((await call('GET', `/v1/orgs/${orgA}/${path}`, { token: ownerB.token })).body.code, path).toBe('NOT_A_MEMBER');
    }
    // A's card ids do not work through B's scope either.
    expect((await call('GET', `/v1/orgs/${orgB}/crm/entries/${entryA}`, { token: ownerB.token })).status).toBe(404);
    expect((await call('POST', `/v1/orgs/${orgB}/crm/entries/${entryA}/stage`, { token: ownerB.token, body: { stage: 'archived' } })).status).toBe(404);
    expect((await call('POST', `/v1/orgs/${orgB}/crm/entries/${entryA}/notes`, { token: ownerB.token, body: { body: 'x' } })).status).toBe(404);
    expect((await call('DELETE', `/v1/orgs/${orgB}/crm/entries/${entryA}`, { token: ownerB.token })).status).toBe(404);
    expect((await call('PATCH', `/v1/orgs/${orgB}/crm/saved-searches/${searchA.body.id}`, { token: ownerB.token, body: { alerts: true } })).status).toBe(404);
    const noteIds = (await env.db.selectFrom('crm_notes').select('id').where('entry_id', '=', entryA).execute()).map((r) => r.id);
    expect((await call('DELETE', `/v1/orgs/${orgB}/crm/notes/${noteIds[0]}`, { token: ownerB.token })).status).toBe(404);
    // And A's members never see B's note.
    const aDetail = await call('GET', `/v1/orgs/${orgA}/crm/entries/${entryA}`, { token: ownerA.token });
    expect(JSON.stringify(aDetail.body)).not.toContain('Beta-only');
    expect((await call('GET', `/v1/orgs/${orgB}/crm/saved-searches`, { token: ownerB.token })).body.items).toEqual([]);
  });

  it('keeps a scout’s personal pipeline private to that scout, and away from the player', async () => {
    const p = await call('PUT', `/v1/scout/crm/players/${winger.userId}`, { token: scoutA.token, body: { stage: 'watching' } });
    expect(p.body.stage).toBe('watching');
    personalEntry = p.body.id;
    await call('POST', `/v1/scout/crm/entries/${personalEntry}/notes`, { token: scoutA.token, body: { body: 'My own private thoughts' } });
    expect((await call('GET', `/v1/scout/crm/entries/${personalEntry}`, { token: ownerA.token })).status).toBe(404);
    expect((await call('GET', '/v1/scout/crm/pipeline', { token: ownerA.token })).body.items).toEqual([]);
    expect((await call('GET', `/v1/orgs/${orgA}/crm/entries/${personalEntry}`, { token: ownerA.token })).status).toBe(404);
    // Personal pipelines are for verified scouts; the player has no way in.
    expect((await call('GET', '/v1/scout/crm/pipeline', { token: winger.token })).body.code).toBe('SCOUT_VERIFICATION_REQUIRED');
    expect((await call('GET', `/v1/scout/crm/entries/${personalEntry}`, { token: winger.token })).status).toBe(403);
    const exported = await call('GET', '/v1/me/export', { token: winger.token });
    expect(exported.status).toBe(200);
    const text = JSON.stringify(exported.body);
    for (const secret of ['My own private thoughts', 'Strong first touch', 'Beta-only', 'u23']) expect(text).not.toContain(secret);
    expect(JSON.stringify((await call('GET', '/v1/profiles/crm_winger', { token: winger.token })).body)).not.toContain('watching');
  });

  it('records every stage change with who and when, and refuses Contacted without an accepted request', async () => {
    const move = (stage: string) => call('POST', `/v1/orgs/${orgA}/crm/entries/${entryA}/stage`, { token: ownerA.token, body: { stage } });
    expect((await move('shortlisted')).body.stage).toBe('shortlisted');
    expect((await move('shortlisted')).body.code).toBe('SAME_STAGE');
    expect((await move('contacted')).body.code).toBe('CONTACT_NOT_ACCEPTED');
    expect((await move('evaluation')).body.code).toBe('CONTACT_NOT_ACCEPTED');
    expect((await move('contact_requested')).body.code).toBe('MESSAGE_REQUIRED');
    expect((await move('monitoring')).body.stage).toBe('monitoring');
    const d = await call('GET', `/v1/orgs/${orgA}/crm/entries/${entryA}`, { token: viewerA.token });
    expect(d.body.history.map((h: Json) => [h.from, h.to, h.changedBy.handle])).toEqual([
      [null, 'new', 'crm_scout_a'], ['new', 'watching', 'crm_scout_a'], ['watching', 'shortlisted', 'crm_owner_a'], ['shortlisted', 'monitoring', 'crm_owner_a'],
    ]);
    expect(d.body.history.every((h: Json) => !Number.isNaN(Date.parse(h.at)))).toBe(true);
    const logged = await env.db.selectFrom('audit_logs').select(['action', 'actor_id', 'metadata']).where('target_id', '=', entryA).orderBy('id').execute();
    expect(logged.map((l) => [l.action, (l.metadata as Json).from, (l.metadata as Json).to])).toEqual([
      ['crm.stage_changed', null, 'new'], ['crm.stage_changed', 'new', 'watching'], ['crm.stage_changed', 'watching', 'shortlisted'], ['crm.stage_changed', 'shortlisted', 'monitoring'],
    ]);
    expect(logged.every((l) => (l.metadata as Json).organizationId === orgA)).toBe(true);
  });

  it('moves to Contact Requested only through the contact-request flow and its consent and privacy rules', async () => {
    const msg = { stage: 'contact_requested', message: 'Alpha Academy would like to invite you to a trial.' };
    // No scout-contact consent yet: refused, and the card stays where it was.
    expect((await call('POST', `/v1/orgs/${orgA}/crm/entries/${entryA}/stage`, { token: ownerA.token, body: msg })).body.code).toBe('CONTACT_NOT_ALLOWED');
    expect((await call('GET', `/v1/orgs/${orgA}/crm/entries/${entryA}`, { token: ownerA.token })).body.stage).toBe('monitoring');
    await grant(winger.token, winger.userId, 'scout_contact');
    // The player's own contact toggle still wins over the consent.
    await call('PATCH', `/v1/users/${winger.userId}/privacy`, { token: winger.token, body: { allowContactRequests: false } });
    expect((await call('POST', `/v1/orgs/${orgA}/crm/entries/${entryA}/stage`, { token: ownerA.token, body: msg })).body.code).toBe('CONTACT_NOT_ALLOWED');
    await call('PATCH', `/v1/users/${winger.userId}/privacy`, { token: winger.token, body: { allowContactRequests: true } });
    const moved = await call('POST', `/v1/orgs/${orgA}/crm/entries/${entryA}/stage`, { token: ownerA.token, body: msg });
    expect(moved.body).toMatchObject({ stage: 'contact_requested', contactRequest: { status: 'pending', viaGuardian: false } });
    // The player sees a normal contact request, from the organization, and nothing of the pipeline.
    const incoming = await call('GET', '/v1/contact-requests', { token: winger.token });
    expect(incoming.body.items).toMatchObject([{ scout: { handle: 'crm_owner_a', organization: 'Alpha Academy' }, viaGuardian: false, status: 'pending' }]);
    expect(JSON.stringify(incoming.body)).not.toContain('monitoring');
    expect((await call('POST', `/v1/orgs/${orgA}/crm/entries/${entryA}/stage`, { token: scoutA.token, body: { ...msg, stage: 'watching' } })).body.stage).toBe('watching');
    expect((await call('POST', `/v1/orgs/${orgA}/crm/entries/${entryA}/stage`, { token: scoutA.token, body: msg })).body.code).toBe('ALREADY_REQUESTED');
    await call('POST', `/v1/contact-requests/${incoming.body.items[0].id}/respond`, { token: winger.token, body: { accept: true } });
    expect((await call('POST', `/v1/orgs/${orgA}/crm/entries/${entryA}/stage`, { token: ownerA.token, body: { stage: 'contacted' } })).body).toMatchObject({ stage: 'contacted', contactRequest: { status: 'accepted' } });
    expect((await call('POST', `/v1/orgs/${orgA}/crm/entries/${entryA}/stage`, { token: ownerA.token, body: { stage: 'evaluation' } })).body.stage).toBe('evaluation');
  });

  it('routes a minor’s Contact Requested to the guardian, and never past them', async () => {
    const kidToken = await env.token('sub-crm-kid', {});
    const kid = await call('POST', '/v1/onboarding/register', { token: kidToken, body: { handle: 'crm_kid', displayName: 'Kid', dob: '2011-03-15', countryCode: 'EG', roles: ['player'] } });
    const kidId = kid.body.userId as string;
    const guardian = await newUser('crm_guardian', ['fan']);
    await call('POST', '/v1/guardians/invitations', { token: kidToken, body: { guardianEmail: guardian.email } });
    await call('POST', '/v1/guardians/invitations/accept', { token: guardian.token, body: { token: env.mailer.invitations.at(-1)!.token } });
    await grant(guardian.token, kidId, 'account');
    // Private until the guardian opens the profile: not discoverable, so not addable.
    expect((await call('PUT', `/v1/scout/crm/players/${kidId}`, { token: scoutA.token, body: {} })).status).toBe(404);
    await grant(guardian.token, kidId, 'public_profile');
    const card = await call('PUT', `/v1/scout/crm/players/${kidId}`, { token: scoutA.token, body: {} });
    expect(card.status).toBe(200);
    // Verified scouts see a minor's age group on the card (as in scout search).
    expect(card.body.player.ageGroup).toBe('u16');
    const msg = { stage: 'contact_requested', message: 'We run a youth trial day and would like to invite your child.' };
    expect((await call('POST', `/v1/scout/crm/entries/${card.body.id}/stage`, { token: scoutA.token, body: msg })).body.code).toBe('CONTACT_NOT_ALLOWED');
    // The minor cannot give the consent; the guardian can.
    expect((await call('POST', '/v1/consents', { token: kidToken, body: { subjectId: kidId, purpose: 'scout_contact', granted: true, policyVersion: 'test-1' } })).body.code).toBe('GUARDIAN_REQUIRED');
    await grant(guardian.token, kidId, 'scout_contact');
    const moved = await call('POST', `/v1/scout/crm/entries/${card.body.id}/stage`, { token: scoutA.token, body: msg });
    expect(moved.body).toMatchObject({ stage: 'contact_requested', contactRequest: { viaGuardian: true, status: 'pending' } });
    expect((await call('GET', '/v1/contact-requests', { token: kidToken })).body.items).toEqual([]);
    expect((await call('GET', '/v1/contact-requests', { token: guardian.token })).body.items).toMatchObject([{ player: { handle: 'crm_kid' }, viaGuardian: true }]);
    // A player who turns scout discovery off drops out of every pipeline.
    await call('PATCH', `/v1/users/${kidId}/privacy`, { token: guardian.token, body: { allowScoutDiscovery: false } });
    expect((await call('GET', '/v1/scout/crm/pipeline', { token: scoutA.token })).body.items.map((i: Json) => i.player.handle)).not.toContain('crm_kid');
    expect((await call('GET', `/v1/scout/crm/entries/${card.body.id}`, { token: scoutA.token })).status).toBe(404);
  });

  it('lets an organization run saved searches only with the right role', async () => {
    expect((await call('POST', `/v1/orgs/${orgA}/crm/saved-searches`, { token: analystA.token, body: { name: 'n', filters: {} } })).status).toBe(403);
    expect((await call('POST', `/v1/orgs/${orgA}/crm/saved-searches`, { token: scoutA.token, body: { name: 'n', filters: { position: 'Winger' } } })).body.code).toBe('VALIDATION_FAILED');
    const list = await call('GET', `/v1/orgs/${orgA}/crm/saved-searches`, { token: viewerA.token });
    expect(list.body.items).toMatchObject([{ name: 'Alpha wingers', filters: { position: 'LW' }, alerts: false, matches: 0, createdBy: { handle: 'crm_scout_a' } }]);
    expect((await call('DELETE', `/v1/orgs/${orgA}/crm/saved-searches/${list.body.items[0].id}`, { token: viewerA.token })).status).toBe(403);
    // striker exists so the filters below have something not to match.
    expect(striker.userId).toBeTruthy();
  });

  it('freezes a reported organization’s pipeline once moderators act, and hides it from the public', async () => {
    const reporter = await newUser('crm_reporter', ['fan']);
    expect((await call('POST', '/v1/reports', { token: reporter.token, body: { targetKind: 'organization', targetId: orgB, reason: 'fake_scout', details: 'Not a real agency' } })).status).toBe(202);
    expect((await call('POST', '/v1/reports', { token: reporter.token, body: { targetKind: 'organization', targetId: crypto.randomUUID(), reason: 'scam' } })).status).toBe(404);
    const mod = await staffAdmin('crm_mod_admin');
    const cases = await call('GET', '/v1/admin/moderation-cases', { token: mod.token });
    const c = cases.body.items.find((x: Json) => x.targetId === orgB);
    expect(c).toMatchObject({ targetKind: 'organization', source: 'report', priority: 1, organization: { name: 'Beta Agency', type: 'agency', verified: false, status: 'active' } });
    expect((await call('POST', `/v1/admin/moderation-cases/${c.id}/decision`, { token: mod.token, body: { decision: 'restrict' } })).status).toBe(204);
    expect((await call('GET', `/v1/orgs/${orgB}`)).status).toBe(404);
    expect((await call('GET', '/v1/orgs/mine', { token: ownerB.token })).body.items).toMatchObject([{ id: orgB, suspended: true }]);
    expect((await call('GET', `/v1/orgs/${orgB}/crm/pipeline`, { token: ownerB.token })).status).toBe(200);
    expect((await call('POST', `/v1/orgs/${orgB}/crm/entries/${entryB}/stage`, { token: ownerB.token, body: { stage: 'watching' } })).body.code).toBe('ORG_SUSPENDED');
    expect((await call('GET', '/v1/notifications', { token: ownerB.token })).body.items.map((n: Json) => n.kind)).toContain('org.suspended');
  });
});

// ------------------------------------------------------------------------------------------------
describe('verification by type', () => {
  let admin: User;
  let owner: User;
  let member: User;
  let orgId: string;

  beforeAll(async () => {
    admin = await staffAdmin('ver_admin');
    owner = await newUser('ver_owner', ['fan']);
    member = await newUser('ver_member', ['fan'], { scout: true });
    orgId = await createOrg(owner, 'Delta School of Football', 'school');
    await join(orgId, owner, member, 'scout');
  });

  it('verifies an organization through the admin queue, and puts the badge on the organization only', async () => {
    const evidence = 'Registered with the national federation, licence 4411.';
    expect((await call('POST', '/v1/verification-requests', { token: member.token, body: { kind: 'organization', organizationId: orgId, evidence } })).body.code).toBe('ORG_ROLE_REQUIRED');
    expect((await call('POST', '/v1/verification-requests', { token: owner.token, body: { kind: 'organization', evidence } })).body.code).toBe('ORGANIZATION_REQUIRED');
    const req = await call('POST', '/v1/verification-requests', { token: owner.token, body: { kind: 'organization', organizationId: orgId, evidence } });
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ kind: 'organization', targetOrganization: { id: orgId, name: 'Delta School of Football', type: 'school' } });
    expect((await call('POST', '/v1/verification-requests', { token: owner.token, body: { kind: 'organization', organizationId: orgId, evidence } })).body.code).toBe('ALREADY_PENDING');
    expect((await call('GET', `/v1/orgs/${orgId}/dashboard`, { token: owner.token })).body.verification.status).toBe('pending');

    const queue = await call('GET', '/v1/admin/verification-requests', { token: admin.token });
    const item = queue.body.items.find((r: Json) => r.id === req.body.id);
    expect(item).toMatchObject({ kind: 'organization', user: { handle: 'ver_owner' }, targetOrganization: { id: orgId, type: 'school', country: 'EG' } });
    expect((await call('POST', `/v1/admin/verification-requests/${item.id}/decision`, { token: admin.token, body: { approve: true } })).status).toBe(204);
    expect((await call('GET', `/v1/orgs/${orgId}`)).body.verified).toBe(true);
    expect((await call('GET', '/v1/profiles/ver_owner')).body.verified).toBe(false);
    expect((await call('GET', `/v1/orgs/${orgId}/dashboard`, { token: member.token })).body.verification.status).toBe('approved');
    expect((await call('POST', '/v1/verification-requests', { token: owner.token, body: { kind: 'organization', organizationId: orgId, evidence } })).body.code).toBe('ALREADY_VERIFIED');
    // Renaming a verified organization takes the badge away until it is verified again.
    await call('PATCH', `/v1/orgs/${orgId}`, { token: owner.token, body: { name: 'Delta Football School' } });
    expect((await call('GET', `/v1/orgs/${orgId}`)).body.verified).toBe(false);
  });

  it('verifies identity for adults, shows each type in the queue, and keeps minors out', async () => {
    const person = await newUser('ver_identity', ['fan']);
    const r = await call('POST', '/v1/verification-requests', { token: person.token, body: { kind: 'identity', evidence: 'Video call available, public LinkedIn profile.' } });
    expect(r.body).toMatchObject({ kind: 'identity', targetOrganization: null });
    const kidToken = await env.token('sub-ver-kid', {});
    const kid = await call('POST', '/v1/onboarding/register', { token: kidToken, body: { handle: 'ver_kid', displayName: 'Kid', dob: '2011-03-15', countryCode: 'EG', roles: ['player'] } });
    await env.db.updateTable('users').set({ status: 'active' }).where('id', '=', kid.body.userId).execute();
    expect((await call('POST', '/v1/verification-requests', { token: kidToken, body: { kind: 'identity', evidence: 'please verify my identity' } })).body.code).toBe('ADULTS_ONLY');
    const queue = await call('GET', '/v1/admin/verification-requests', { token: admin.token });
    expect(queue.body.items.find((x: Json) => x.id === r.body.id)).toMatchObject({ kind: 'identity', user: { handle: 'ver_identity' } });
    await call('POST', `/v1/admin/verification-requests/${r.body.id}/decision`, { token: admin.token, body: { approve: true } });
    expect((await call('GET', '/v1/profiles/ver_identity')).body.verified).toBe(true);
    const actions = (await env.db.selectFrom('audit_logs').select(['action', 'target_kind']).where('action', 'like', 'verification.%').execute());
    expect(actions).toEqual(expect.arrayContaining([{ action: 'verification.approved', target_kind: 'organization' }, { action: 'verification.approved', target_kind: 'user' }]));
  });
});

// ------------------------------------------------------------------------------------------------
describe('saved-search alerts', () => {
  let scout: User;
  let orgScout: User;
  let quietScout: User;
  let admin: User;
  let winger: User;
  let striker: User;
  let orgId: string;

  beforeAll(async () => {
    scout = await newUser('alert_scout', ['fan'], { scout: true });
    orgScout = await newUser('alert_org_scout', ['fan'], { scout: true });
    quietScout = await newUser('alert_quiet_scout', ['fan'], { scout: true });
    admin = await staffAdmin('alert_admin');
    winger = await player('alert_winger', 'LW');
    striker = await player('alert_striker', 'ST');
    orgId = await createOrg(orgScout, 'Gamma Club', 'club');
    const filters = { position: 'LW', country: 'EG', skill: 'dribbling' };
    expect((await call('POST', '/v1/scout/crm/saved-searches', { token: scout.token, body: { name: 'EG left wingers', filters, alerts: true } })).status).toBe(201);
    expect((await call('POST', `/v1/orgs/${orgId}/crm/saved-searches`, { token: orgScout.token, body: { name: 'Club wingers', filters: { position: 'LW' }, alerts: true } })).status).toBe(201);
    await call('POST', '/v1/scout/crm/saved-searches', { token: quietScout.token, body: { name: 'Muted', filters: { position: 'LW' }, alerts: true } });
    await call('POST', '/v1/scout/crm/saved-searches', { token: quietScout.token, body: { name: 'Alerts off', filters: { position: 'LW' }, alerts: false } });
    // shortlist_activity off: saved-search alerts are scouting activity.
    expect((await call('PATCH', '/v1/me/notification-preferences', { token: quietScout.token, body: { shortlistActivity: false } })).body.shortlistActivity).toBe(false);
  });

  const alerts = async (u: User) => (await call('GET', '/v1/notifications', { token: u.token })).body.items.filter((n: Json) => n.kind === 'saved_search.match');

  it('notifies the search owner when a moderator publishes a matching clip, once, and respects preferences', async () => {
    const wing = await clipInReview(winger.token, { position: 'LW' });
    const strike = await clipInReview(striker.token, { position: 'ST' });
    for (const c of [wing, strike]) {
      expect((await call('POST', `/v1/admin/moderation-cases/${c.caseId}/decision`, { token: admin.token, body: { decision: 'approve' } })).status).toBe(204);
    }
    const mine = await alerts(scout);
    expect(mine).toHaveLength(1);
    expect(mine[0].payload).toMatchObject({ name: 'EG left wingers', clips: 1, playersCount: 1, players: [{ userId: winger.userId, handle: 'alert_winger' }], handle: 'alert_winger', organizationId: null });
    const club = await alerts(orgScout);
    expect(club).toHaveLength(1);
    expect(club[0].payload).toMatchObject({ name: 'Club wingers', organizationId: orgId });
    // Preference off: no notification, but the match is recorded so it is never sent later either.
    expect(await alerts(quietScout)).toEqual([]);
    const quietSearches = await call('GET', '/v1/scout/crm/saved-searches', { token: quietScout.token });
    expect(quietSearches.body.items.map((s: Json) => [s.name, s.matches]).sort()).toEqual([['Alerts off', 0], ['Muted', 1]]);
    // A later sweep (the worker's maintenance step) finds nothing new to send.
    expect((await runSavedSearchAlerts(env.db)).notifications).toBe(0);
    expect(await alerts(scout)).toHaveLength(1);
  });

  it('matches only players a scout could find, and only clips published after alerts were switched on', async () => {
    // Discovery off: never alerted.
    const shy = await player('alert_shy', 'LW');
    await call('PATCH', `/v1/users/${shy.userId}/privacy`, { token: shy.token, body: { allowScoutDiscovery: false } });
    const shyClip = await clipInReview(shy.token);
    await call('POST', `/v1/admin/moderation-cases/${shyClip.caseId}/decision`, { token: admin.token, body: { decision: 'approve' } });
    // Blocked the scout: never alerted to that scout.
    const blocker = await player('alert_blocker', 'LW');
    await call('PUT', `/v1/users/${scout.userId}/block`, { token: blocker.token });
    const blockerClip = await clipInReview(blocker.token);
    await call('POST', `/v1/admin/moderation-cases/${blockerClip.caseId}/decision`, { token: admin.token, body: { decision: 'approve' } });
    expect(await alerts(scout)).toHaveLength(1);
    const clubAlerts = await alerts(orgScout);
    expect(clubAlerts).toHaveLength(2);
    expect(clubAlerts[0].payload.players).toEqual([{ userId: blocker.userId, handle: 'alert_blocker' }]);

    // Clips published before alerts were turned on are not alerted when they are turned on.
    const off = await call('POST', '/v1/scout/crm/saved-searches', { token: scout.token, body: { name: 'Later', filters: { position: 'LW' }, alerts: false } });
    const before = await clipInReview(winger.token);
    await call('POST', `/v1/admin/moderation-cases/${before.caseId}/decision`, { token: admin.token, body: { decision: 'approve' } });
    await new Promise((r) => setTimeout(r, 5));
    expect((await call('PATCH', `/v1/scout/crm/saved-searches/${off.body.id}`, { token: scout.token, body: { alerts: true } })).body.alerts).toBe(true);
    await runSavedSearchAlerts(env.db);
    expect((await alerts(scout)).map((n: Json) => n.payload.name)).toEqual(['EG left wingers', 'EG left wingers']);
  });

  it('catches up in the maintenance sweep for clips published without the immediate call', async () => {
    const fresh = await player('alert_fresh', 'LW');
    const c = await clipInReview(fresh.token);
    // As if the publish-time call had failed: publish directly.
    await env.db.updateTable('videos').set({ status: 'published', safety_status: 'APPROVED', moderation: 'safe', published_at: new Date() }).where('id', '=', c.videoId).execute();
    const before = (await alerts(orgScout)).length;
    const report = await runSavedSearchAlerts(env.db, { now: new Date(Date.now() + 1000) });
    expect(report.notifications).toBeGreaterThanOrEqual(1);
    const after = await alerts(orgScout);
    expect(after).toHaveLength(before + 1);
    expect(after[0].payload.handle).toBe('alert_fresh');
  });
});
