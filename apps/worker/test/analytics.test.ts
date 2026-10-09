import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { computeNorthStar, recordEvent, rollupAnalytics, rollupDay } from '../src/analytics.js';
import { createTestDb, seedUser } from './helpers.js';
import type { TestDb } from './helpers.js';

let tdb: TestDb;
const DAY = 86_400_000;

beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb?.close();
});

const db = () => tdb.db;
const at = (iso: string) => new Date(iso);

async function role(userId: string, r: string) {
  await db().insertInto('user_roles').values({ user_id: userId, role: r }).onConflict((oc) => oc.doNothing()).execute();
}
async function player(ageBand: 'adult' | 'u16' = 'adult') {
  const id = await seedUser(db(), ageBand);
  await role(id, 'player');
  return id;
}
async function scout() {
  const id = await seedUser(db());
  await role(id, 'scout');
  return id;
}
async function event(name: string, userId: string | null, createdAt: Date, properties: Record<string, unknown> = {}) {
  await db().insertInto('analytics_events').values({ name, user_id: userId, source: 'server', properties: JSON.stringify(properties), created_at: createdAt }).execute();
}
async function daily(day: string, metric: string) {
  const row = await db().selectFrom('analytics_daily').select('value').where('day', '=', sql<Date>`${day}::date`).where('metric', '=', metric).executeTakeFirst();
  return row ? Number(row.value) : undefined;
}
async function shortlistAdd(scoutId: string, playerId: string, when: Date) {
  const id = uuidv7();
  await db().insertInto('shortlists').values({ id, owner_id: scoutId, name: 'List', created_at: when }).execute();
  await db().insertInto('shortlist_players').values({ shortlist_id: id, player_id: playerId, added_at: when }).execute();
}
async function northStarDay(day: string) {
  return db().transaction().execute((tx) => computeNorthStar(tx, day));
}

describe('recordEvent', () => {
  it('validates against the registry, drops unknown and invalid events', async () => {
    const u = await player();
    const drops: string[] = [];
    const onDrop = (r: string) => drops.push(r);
    expect(await recordEvent(db(), 'video_liked', { videoId: uuidv7() }, { userId: u }, { onDrop })).toBe(true);
    expect(await recordEvent(db(), 'made_up_event', {}, { userId: u }, { onDrop })).toBe(false);
    expect(await recordEvent(db(), 'video_liked', { videoId: 'not-a-uuid' }, { userId: u }, { onDrop })).toBe(false);
    // Extra properties (a place PII could sneak in) are refused, not silently stored.
    expect(await recordEvent(db(), 'video_liked', { videoId: uuidv7(), email: 'x@y.z' }, { userId: u }, { onDrop })).toBe(false);
    // A server-only event cannot come from a client.
    expect(await recordEvent(db(), 'subscription_activated', { planKey: 'scout_pro', status: 'active' }, { userId: u }, { source: 'client', onDrop })).toBe(false);
    expect(drops).toEqual(['unknown_event', 'invalid_properties', 'invalid_properties', 'not_allowed_from_client']);
    const rows = await db().selectFrom('analytics_events').selectAll().where('user_id', '=', u).execute();
    expect(rows.map((r) => r.name)).toEqual(['video_liked']);
  });

  it('records only strictly necessary events for someone who turned analytics off', async () => {
    const u = await player();
    await db().insertInto('privacy_settings').values({ user_id: u, allow_analytics: false }).execute();
    expect(await recordEvent(db(), 'video_liked', { videoId: uuidv7() }, { userId: u })).toBe(false);
    expect(await recordEvent(db(), 'checkout_started', { planKey: 'player_pro', interval: 'month', trial: true }, { userId: u })).toBe(true);
    const rows = await db().selectFrom('analytics_events').select('name').where('user_id', '=', u).execute();
    expect(rows.map((r) => r.name)).toEqual(['checkout_started']);
  });

  it('strips identifying properties from a minor’s events, keeping ids', async () => {
    const kid = await player('u16');
    const adult = await player();
    await recordEvent(db(), 'signup_completed', { roles: ['player'], scoutApplication: false, locale: 'ar', country: 'EG' }, { userId: kid });
    await recordEvent(db(), 'signup_completed', { roles: ['player'], scoutApplication: false, locale: 'ar', country: 'EG' }, { userId: adult });
    const props = async (id: string) => (await db().selectFrom('analytics_events').select('properties').where('user_id', '=', id).executeTakeFirstOrThrow()).properties;
    await expect(props(kid)).resolves.toEqual({ roles: ['player'], scoutApplication: false, locale: 'ar' });
    await expect(props(adult)).resolves.toEqual({ roles: ['player'], scoutApplication: false, locale: 'ar', country: 'EG' });
  });
});

describe('North Star: qualified talent discoveries', () => {
  it('counts a verified scout’s shortlist add once per pair per 30 days', async () => {
    const s = await scout();
    const p = await player();
    const p2 = await player();
    await shortlistAdd(s, p, at('2026-03-01T10:00:00Z'));
    await shortlistAdd(s, p, at('2026-03-01T11:00:00Z')); // same day, same pair
    await shortlistAdd(s, p2, at('2026-03-01T12:00:00Z'));
    expect(await northStarDay('2026-03-01')).toBe(2);
    // Again 10 days later: inside the window, not counted.
    await shortlistAdd(s, p, at('2026-03-11T10:00:00Z'));
    expect(await northStarDay('2026-03-11')).toBe(0);
    // Day 30 after the counted day: a new window.
    await shortlistAdd(s, p, at('2026-03-31T10:00:00Z'));
    expect(await northStarDay('2026-03-31')).toBe(1);
    // Recomputing a day gives the same answer (it replaces its own rows).
    expect(await northStarDay('2026-03-31')).toBe(1);
  });

  it('ignores unverified scouts, self pairs, inactive players and non-players', async () => {
    const fan = await seedUser(db()); // no scout role
    const s = await scout();
    const p = await player();
    const suspended = await player();
    await db().updateTable('users').set({ status: 'suspended' }).where('id', '=', suspended).execute();
    const notAPlayer = await seedUser(db());
    await shortlistAdd(fan, p, at('2026-04-02T10:00:00Z'));
    await shortlistAdd(s, suspended, at('2026-04-02T10:00:00Z'));
    await shortlistAdd(s, notAPlayer, at('2026-04-02T10:00:00Z'));
    expect(await northStarDay('2026-04-02')).toBe(0);
  });

  it('counts pipeline stages from Shortlisted on (not Archived) and contact requests, crediting verified organizations', async () => {
    const s = await scout();
    const p1 = await player();
    const p2 = await player();
    const p3 = await player();
    const when = at('2026-05-05T09:00:00Z');
    // Personal card moved to Watching (not qualifying) then to Archived (not qualifying).
    const e1 = uuidv7();
    await db().insertInto('crm_entries').values({ id: e1, owner_user_id: s, player_id: p1, stage: 'archived' }).execute();
    await db().insertInto('crm_stage_history').values([
      { id: uuidv7(), entry_id: e1, from_stage: null, to_stage: 'watching', changed_by: s, created_at: when },
      { id: uuidv7(), entry_id: e1, from_stage: 'watching', to_stage: 'archived', changed_by: s, created_at: when },
    ]).execute();
    // A verified organization's card moved to Shortlisted: the organization is the discoverer.
    const org = uuidv7();
    await db().insertInto('organizations').values({ id: org, name: 'Academy', type: 'academy', verified_at: when, created_by: s }).execute();
    const e2 = uuidv7();
    await db().insertInto('crm_entries').values({ id: e2, organization_id: org, player_id: p2, stage: 'shortlisted' }).execute();
    await db().insertInto('crm_stage_history').values({ id: uuidv7(), entry_id: e2, from_stage: 'new', to_stage: 'shortlisted', changed_by: s, created_at: when }).execute();
    // A contact request by the scout.
    await db().insertInto('contact_requests').values({ id: uuidv7(), scout_id: s, player_id: p3, routed_to: p3, message: 'Hello', created_at: when }).execute();
    expect(await northStarDay('2026-05-05')).toBe(2);
    const rows = await db().selectFrom('qualified_discoveries').select(['discoverer_kind', 'discoverer_id', 'player_id', 'source'])
      .where('day', '=', sql<Date>`'2026-05-05'::date`).orderBy('source').execute();
    expect(rows).toEqual([
      { discoverer_kind: 'scout', discoverer_id: s, player_id: p3, source: 'contact_request' },
      { discoverer_kind: 'organization', discoverer_id: org, player_id: p2, source: 'pipeline' },
    ]);
  });
});

describe('rollup and retention', () => {
  it('rolls complete days into daily aggregates, then deletes raw events past retention', async () => {
    const fresh = await createTestDb();
    try {
      const d = fresh.db;
      const u1 = await seedUser(d);
      const u2 = await seedUser(d);
      const add = (name: string, userId: string | null, iso: string) =>
        d.insertInto('analytics_events').values({ name, user_id: userId, source: 'server', properties: '{}', created_at: new Date(iso) }).execute();
      await add('video_liked', u1, '2026-10-06T08:00:00Z');
      await add('video_liked', u1, '2026-10-06T09:00:00Z');
      await add('video_liked', u2, '2026-10-06T23:59:59Z');
      await add('page_viewed', null, '2026-10-06T10:00:00Z');
      await add('upload_started', u1, '2026-10-07T10:00:00Z');
      await add('video_liked', u1, '2026-10-08T01:00:00Z'); // today: not rolled yet
      // 200 days old: rolled up (as an older day with raw events) and then deleted.
      await add('upload_started', u2, '2026-03-22T12:00:00Z');

      const now = new Date('2026-10-08T12:00:00Z');
      const report = await rollupAnalytics(d, now, { backfillDays: 5, retentionDays: 180 });
      expect(report).toEqual({ daysRolled: 6, eventsDeleted: 1, discoveries: 0 });

      const value = async (day: string, metric: string) => {
        const row = await d.selectFrom('analytics_daily').select('value').where('day', '=', sql<Date>`${day}::date`).where('metric', '=', metric).executeTakeFirst();
        return row ? Number(row.value) : undefined;
      };
      expect(await value('2026-10-06', 'event:video_liked')).toBe(3);
      expect(await value('2026-10-06', 'users:video_liked')).toBe(2);
      expect(await value('2026-10-06', 'event:page_viewed')).toBe(1);
      expect(await value('2026-10-06', 'dau')).toBe(2);
      expect(await value('2026-10-07', 'dau')).toBe(1);
      expect(await value('2026-10-07', 'wau')).toBe(2);
      expect(await value('2026-10-07', 'north_star')).toBe(0);
      expect(await value('2026-10-08', '_rolled')).toBeUndefined();
      expect(await value('2026-03-22', 'event:upload_started')).toBe(1);
      expect(await value('2026-10-04', '_rolled')).toBe(1); // empty days are rolled too, so the trend has no gaps

      const left = await d.selectFrom('analytics_events').select('created_at').orderBy('created_at').execute();
      expect(left).toHaveLength(6);
      expect(left[0]!.created_at.toISOString()).toBe('2026-10-06T08:00:00.000Z');

      // A second run the same day has nothing left to do.
      expect(await rollupAnalytics(d, now, { backfillDays: 5, retentionDays: 180 })).toEqual({ daysRolled: 0, eventsDeleted: 0, discoveries: 0 });
      // The next day rolls just the newly completed day.
      expect((await rollupAnalytics(d, new Date(now.getTime() + DAY), { backfillDays: 5, retentionDays: 180 })).daysRolled).toBe(1);
      expect(await value('2026-10-08', 'event:video_liked')).toBe(1);
    } finally {
      await fresh.close();
    }
  });

  it('never deletes raw events whose day has not been rolled up', async () => {
    const old = new Date('2025-01-01T12:00:00Z');
    const u = await seedUser(db());
    await event('video_liked', u, old);
    // Retention is applied right after the rollup in the same run, so the old day is rolled first.
    await rollupDay(db(), '2025-01-02'); // a different day only
    const before = await db().selectFrom('analytics_events').select('id').where('created_at', '=', old).execute();
    expect(before).toHaveLength(1);
    expect(await daily('2025-01-01', '_rolled')).toBeUndefined();
    const report = await rollupAnalytics(db(), new Date('2026-10-08T12:00:00Z'), { backfillDays: 1, retentionDays: 180 });
    expect(report.daysRolled).toBeGreaterThanOrEqual(2);
    expect(await daily('2025-01-01', 'event:video_liked')).toBe(1);
    expect(await db().selectFrom('analytics_events').select('id').where('created_at', '=', old).execute()).toHaveLength(0);
  });
});
