import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { runSavedSearchAlerts } from '../src/alerts.js';
import { runMaintenance, DEFAULT_MAINTENANCE } from '../src/maintenance.js';
import { createEnv, createTestDb, seedUser, silentLog } from './helpers.js';
import type { Env, TestDb } from './helpers.js';

let tdb: TestDb;
let env: Env;
const now = new Date('2026-10-08T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const HOUR = 60;

beforeAll(async () => {
  tdb = await createTestDb();
  env = await createEnv(tdb.db);
});
afterAll(async () => {
  await env?.close();
  await tdb?.close();
});
beforeEach(async () => {
  // Each test starts with no clips and no searches, so earlier players cannot match.
  await env.db.deleteFrom('videos').execute();
  await env.db.deleteFrom('saved_searches').execute();
  await env.db.deleteFrom('notifications').execute();
});

let regionEG: string;
async function eg() {
  regionEG ??= (await env.db.selectFrom('regions').select('id').where('code', '=', 'EG').executeTakeFirstOrThrow()).id;
  return regionEG;
}

/** A discoverable player (public, scout discovery on, player role) with facts scouts filter on. */
async function player(opts: { position?: string; ageBand?: 'u16' | 'adult'; privacy?: Record<string, unknown>; verified?: boolean; handle?: string } = {}) {
  const id = await seedUser(env.db, opts.ageBand ?? 'adult');
  await env.db.insertInto('user_roles').values({ user_id: id, role: 'player' }).execute();
  await env.db.insertInto('privacy_settings').values({ user_id: id, profile_visibility: 'public', ...opts.privacy }).execute();
  await env.db.insertInto('player_profiles').values({ user_id: id, primary_position: opts.position ?? 'LW', preferred_foot: 'left' }).execute();
  await env.db.updateTable('profiles').set({ region_id: await eg(), verified_at: opts.verified ? now : null, ...(opts.handle ? { handle: opts.handle } : {}) })
    .where('user_id', '=', id).execute();
  return id;
}

async function scout(roles: string[] = ['scout']) {
  const id = await seedUser(env.db);
  for (const role of roles) await env.db.insertInto('user_roles').values({ user_id: id, role }).execute();
  return id;
}

async function clip(owner: string, opts: { publishedAt?: Date; skill?: string; status?: string; visibility?: string } = {}) {
  const id = uuidv7();
  await env.db.insertInto('videos').values({
    id, owner_user_id: owner, original_key: `originals/${id}.mp4`, declared_type: 'video/mp4', size_bytes: 1, title: 'clip',
    status: opts.status ?? 'published', visibility: opts.visibility ?? 'public', published_at: opts.publishedAt ?? minutesAgo(10),
    safety_status: (opts.status ?? 'published') === 'published' ? 'APPROVED' : 'HUMAN_REVIEW',
  }).execute();
  if (opts.skill) await env.db.insertInto('video_skills').values({ video_id: id, skill_key: opts.skill, source: 'ai', confidence: 0.9 }).execute();
  return id;
}

async function search(createdBy: string, filters: Record<string, unknown>, opts: { orgId?: string; alerts?: boolean; since?: Date } = {}) {
  const id = uuidv7();
  await env.db.insertInto('saved_searches').values({
    id, owner_user_id: opts.orgId ? null : createdBy, organization_id: opts.orgId ?? null, created_by: createdBy, name: `search ${id.slice(-4)}`,
    filters: JSON.stringify(filters), alerts_enabled: opts.alerts ?? true, alerts_since: opts.since ?? minutesAgo(2 * HOUR),
  }).execute();
  return id;
}

const alertsFor = (userId: string) =>
  env.db.selectFrom('notifications').selectAll().where('user_id', '=', userId).where('kind', '=', 'saved_search.match').execute();

describe('saved-search alerts', () => {
  it('matches the scout-search filters, honouring what the player chose to hide', async () => {
    const s = await scout();
    const lw = await player({ position: 'LW', handle: 'alert_lw_one' });
    const st = await player({ position: 'ST' });
    const noCountry = await player({ position: 'LW', privacy: { show_country: false } });
    const minorHiddenAge = await player({ position: 'LW', ageBand: 'u16', privacy: { show_age: false } });
    const minorShownAge = await player({ position: 'LW', ageBand: 'u16' });
    for (const p of [lw, st, noCountry, minorHiddenAge, minorShownAge]) await clip(p, { skill: p === st ? 'finishing' : 'dribbling' });

    const byCountry = await search(s, { position: 'LW', country: 'EG' });
    const byAge = await search(s, { ageGroup: 'u16' });
    const bySkill = await search(s, { skill: 'finishing' });
    const byName = await search(s, { q: 'alert_lw' });
    const verifiedOnly = await search(s, { verifiedOnly: true });
    await runSavedSearchAlerts(env.db, { now });
    const hits = async (id: string) => (await env.db.selectFrom('saved_search_hits').select('player_id').where('saved_search_id', '=', id).execute()).map((h) => h.player_id).sort();
    expect(await hits(byCountry)).toEqual([lw, minorHiddenAge, minorShownAge].sort());
    expect(await hits(byAge)).toEqual([minorShownAge]);
    expect(await hits(bySkill)).toEqual([st]);
    expect(await hits(byName)).toEqual([lw]);
    expect(await hits(verifiedOnly)).toEqual([]);
  });

  it('never matches players who are private, unlisted, discovery-off, suspended, blocked, or clips that are not public', async () => {
    const s = await scout();
    const ok = await player();
    const hidden = [
      await player({ privacy: { profile_visibility: 'private' } }),
      await player({ privacy: { profile_visibility: 'unlisted' } }),
      await player({ privacy: { allow_scout_discovery: false } }),
      await player(),
      await player(),
    ];
    await env.db.updateTable('users').set({ status: 'suspended' }).where('id', '=', hidden[3]!).execute();
    await env.db.insertInto('blocks').values({ blocker_id: hidden[4]!, blocked_id: s }).execute();
    for (const p of [ok, ...hidden]) await clip(p);
    await clip(ok, { visibility: 'followers' });
    await clip(ok, { status: 'review_required' });
    const id = await search(s, { position: 'LW' });
    const report = await runSavedSearchAlerts(env.db, { now });
    expect(report.hits).toBe(1);
    const [n] = await alertsFor(s);
    expect(n?.payload).toMatchObject({ savedSearchId: id, clips: 1, playersCount: 1, players: [{ userId: ok }] });
  });

  it('sends one notification per search per run, never twice, and only for clips inside the window', async () => {
    const s = await scout();
    const a = await player();
    const b = await player();
    await clip(a);
    await clip(a, { publishedAt: minutesAgo(20) });
    await clip(b);
    await clip(b, { publishedAt: minutesAgo(3 * HOUR) }); // before alerts were switched on
    await clip(b, { publishedAt: minutesAgo(-5) }); // after `now`: the next run's business
    await search(s, { position: 'LW' });
    const first = await runSavedSearchAlerts(env.db, { now });
    expect(first).toMatchObject({ hits: 3, notifications: 1 });
    expect((await alertsFor(s))[0]?.payload).toMatchObject({ clips: 3, playersCount: 2 });
    expect(await runSavedSearchAlerts(env.db, { now })).toMatchObject({ hits: 0, notifications: 0 });
    expect(await alertsFor(s)).toHaveLength(1);
    // A later run picks up the clip that was in the future, once.
    expect(await runSavedSearchAlerts(env.db, { now: new Date(now.getTime() + 10 * 60_000) })).toMatchObject({ hits: 1, notifications: 1 });
  });

  it('only looks back a bounded window, so long-dormant clips are never alerted', async () => {
    const s = await scout();
    const p = await player();
    await clip(p, { publishedAt: minutesAgo(8 * 24 * HOUR) });
    await search(s, { position: 'LW' }, { since: minutesAgo(30 * 24 * HOUR) });
    expect((await runSavedSearchAlerts(env.db, { now })).hits).toBe(0);
  });

  it('records the match but sends nothing when the scout turned shortlist activity off', async () => {
    const s = await scout();
    await env.db.insertInto('notification_preferences').values({ user_id: s, shortlist_activity: false }).execute();
    await clip(await player());
    const id = await search(s, { position: 'LW' });
    expect(await runSavedSearchAlerts(env.db, { now })).toMatchObject({ hits: 1, notifications: 0 });
    expect(await alertsFor(s)).toEqual([]);
    expect(await env.db.selectFrom('saved_search_hits').select('video_id').where('saved_search_id', '=', id).execute()).toHaveLength(1);
  });

  it('alerts only creators who can still scout: verified, active, and a member of an active organization', async () => {
    await clip(await player());
    const notScout = await scout([]);
    await search(notScout, { position: 'LW' });
    const suspended = await scout();
    await env.db.updateTable('users').set({ status: 'suspended' }).where('id', '=', suspended).execute();
    await search(suspended, { position: 'LW' });
    const off = await scout();
    await search(off, { position: 'LW' }, { alerts: false });

    const member = await scout();
    const formerMember = await scout();
    const orgId = uuidv7();
    await env.db.insertInto('organizations').values({ id: orgId, name: 'Gamma', type: 'club' }).execute();
    await env.db.insertInto('organization_members').values({ organization_id: orgId, user_id: member, role: 'scout' }).execute();
    await search(member, { position: 'LW' }, { orgId });
    await search(formerMember, { position: 'LW' }, { orgId });
    const suspendedOrg = uuidv7();
    const inSuspended = await scout();
    await env.db.insertInto('organizations').values({ id: suspendedOrg, name: 'Delta', type: 'club', status: 'suspended' }).execute();
    await env.db.insertInto('organization_members').values({ organization_id: suspendedOrg, user_id: inSuspended, role: 'owner' }).execute();
    await search(inSuspended, { position: 'LW' }, { orgId: suspendedOrg });

    const report = await runSavedSearchAlerts(env.db, { now });
    expect(report.notifications).toBe(1);
    for (const u of [notScout, suspended, off, formerMember, inSuspended]) expect(await alertsFor(u)).toEqual([]);
    expect((await alertsFor(member))[0]?.payload).toMatchObject({ organizationId: orgId });
  });

  it('skips a search whose stored filters no longer pass the scout search schema', async () => {
    const s = await scout();
    await clip(await player());
    await search(s, { position: 'Winger' });
    await search(s, { position: 'LW' });
    expect(await runSavedSearchAlerts(env.db, { now })).toMatchObject({ searches: 1, notifications: 1 });
  });

  it('runs as a maintenance step', async () => {
    const s = await scout();
    await clip(await player());
    await search(s, { position: 'LW' });
    const report = await runMaintenance(env.db, env.storage, silentLog, now, DEFAULT_MAINTENANCE);
    expect(report.alertNotifications).toBe(1);
    expect(await alertsFor(s)).toHaveLength(1);
  });
});
