/**
 * Saved-search alerts. A scout (or an organization member) saves a scout search with alerts on;
 * when a clip is published whose player matches it, they get one in-app notification per run.
 *
 * Called right after a clip is published (by the worker pipeline and by a moderator's approval in
 * the API) and as a step of every maintenance run, which catches anything the immediate call
 * missed. Each (saved search, clip) pair is recorded in `saved_search_hits`, so overlapping runs,
 * retries and concurrent callers never notify twice.
 *
 * The match mirrors the API's scout search (apps/api/src/modules/catalog.ts `discoverablePlayers`
 * and `filterPlayers`, plus the scout-only filters in scout.ts): only active, public,
 * discovery-allowed players with the player role, never across a block, country only where shown,
 * age group only where shown. For alerts, a skill filter must match the new clip itself.
 */
import { v7 as uuidv7 } from 'uuid';
import type { Database } from '@fp/db';
import { SavedSearchFilters } from '@fp/contracts';
import { shouldDeliver } from '@fp/domain';
import type { NotificationPreferences } from '@fp/domain';

export const SAVED_SEARCH_ALERT_KIND = 'saved_search.match';

export interface AlertOptions {
  now?: Date;
  /** Only consider these clips (the immediate call after publishing). */
  videoIds?: readonly string[];
  /** How far back a run looks for clips it may have missed (default 7 days). */
  lookbackMs?: number;
  /** Most players named in one notification. */
  maxPlayersPerNotification?: number;
}

export interface AlertReport {
  searches: number;
  hits: number;
  notifications: number;
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function runSavedSearchAlerts(db: Database, opts: AlertOptions = {}): Promise<AlertReport> {
  const now = opts.now ?? new Date();
  const report: AlertReport = { searches: 0, hits: 0, notifications: 0 };
  if (opts.videoIds && opts.videoIds.length === 0) return report;
  const earliest = new Date(now.getTime() - (opts.lookbackMs ?? 7 * 24 * 3_600_000));

  // Searches whose creator can still receive alerts: an active verified scout (or admin), and for an
  // organization's search, still a member of an active organization.
  const searches = await db.selectFrom('saved_searches')
    .innerJoin('users', 'users.id', 'saved_searches.created_by')
    .leftJoin('organizations', 'organizations.id', 'saved_searches.organization_id')
    .select(['saved_searches.id', 'saved_searches.name', 'saved_searches.filters', 'saved_searches.alerts_since', 'saved_searches.created_by',
      'saved_searches.organization_id'])
    .where('saved_searches.alerts_enabled', '=', true)
    .where('users.status', '=', 'active')
    .where(({ exists, selectFrom }) => exists(selectFrom('user_roles').select('user_roles.user_id')
      .whereRef('user_roles.user_id', '=', 'saved_searches.created_by').where('user_roles.role', 'in', ['scout', 'admin'])))
    .where((eb) => eb.or([
      eb('saved_searches.organization_id', 'is', null),
      eb.and([
        eb('organizations.status', '=', 'active'),
        eb.exists(eb.selectFrom('organization_members').select('organization_members.user_id')
          .whereRef('organization_members.organization_id', '=', 'saved_searches.organization_id')
          .whereRef('organization_members.user_id', '=', 'saved_searches.created_by')),
      ]),
    ]))
    .orderBy('saved_searches.id')
    .execute();

  for (const s of searches) {
    const parsed = SavedSearchFilters.safeParse(s.filters);
    if (!parsed.success) continue;
    const f = parsed.data;
    report.searches++;
    const recipient = s.created_by;
    const since = s.alerts_since > earliest ? s.alerts_since : earliest;

    let q = db.selectFrom('videos')
      .innerJoin('users', 'users.id', 'videos.owner_user_id')
      .innerJoin('profiles', 'profiles.user_id', 'users.id')
      .innerJoin('privacy_settings', 'privacy_settings.user_id', 'users.id')
      .innerJoin('age_records', 'age_records.user_id', 'users.id')
      .innerJoin('user_roles', (j) => j.onRef('user_roles.user_id', '=', 'users.id').on('user_roles.role', '=', 'player'))
      .leftJoin('player_profiles', 'player_profiles.user_id', 'users.id')
      .leftJoin('regions', 'regions.id', 'profiles.region_id')
      .select(['videos.id as video_id', 'users.id as player_id', 'profiles.handle', 'videos.published_at'])
      .where('videos.status', '=', 'published')
      .where('videos.visibility', '=', 'public')
      .where('videos.deleted_at', 'is', null)
      .where('videos.published_at', '>', since)
      .where('users.status', '=', 'active')
      .where('users.id', '!=', recipient)
      .where('privacy_settings.profile_visibility', '=', 'public')
      .where('privacy_settings.allow_scout_discovery', '=', true)
      .where(({ not, exists, selectFrom, or, and }) => not(exists(selectFrom('blocks').select('blocks.blocker_id').where((b) => or([
        and([b('blocks.blocker_id', '=', recipient), b('blocks.blocked_id', '=', b.ref('users.id'))]),
        and([b('blocks.blocked_id', '=', recipient), b('blocks.blocker_id', '=', b.ref('users.id'))]),
      ])))))
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('saved_search_hits').select('saved_search_hits.video_id')
        .where('saved_search_hits.saved_search_id', '=', s.id).whereRef('saved_search_hits.video_id', '=', 'videos.id'))));
    // The immediate call names the clip; a sweep looks at everything published up to `now`.
    q = opts.videoIds ? q.where('videos.id', 'in', [...opts.videoIds]) : q.where('videos.published_at', '<=', now);
    if (f.q) q = q.where((eb) => eb.or([eb('profiles.handle', 'ilike', likePattern(f.q!)), eb('profiles.display_name', 'ilike', likePattern(f.q!))]));
    if (f.country) {
      q = q.where('regions.country_code', '=', f.country).where('privacy_settings.region_precision', '!=', 'macro').where('privacy_settings.show_country', '=', true);
    }
    if (f.position) q = q.where('player_profiles.primary_position', '=', f.position);
    if (f.foot) q = q.where('player_profiles.preferred_foot', '=', f.foot);
    if (f.skill) {
      q = q.where(({ exists, selectFrom }) => exists(selectFrom('video_skills').select('video_skills.video_id')
        .whereRef('video_skills.video_id', '=', 'videos.id').where('video_skills.status', '=', 'active').where('video_skills.skill_key', '=', f.skill!)));
    }
    // A hidden age group cannot be matched on either.
    if (f.ageGroup) q = q.where('age_records.age_band', '=', f.ageGroup).where('privacy_settings.show_age', '=', true);
    if (f.verifiedOnly) q = q.where('profiles.verified_at', 'is not', null);
    if (f.minFollowers) {
      q = q.where((eb) => eb(eb.selectFrom('follows').select(eb.fn.countAll().as('n')).whereRef('follows.followee_id', '=', 'users.id'), '>=', f.minFollowers!));
    }
    const matches = await q.orderBy('videos.published_at').limit(200).execute();
    if (!matches.length) continue;

    await db.transaction().execute(async (tx) => {
      const inserted = await tx.insertInto('saved_search_hits')
        .values(matches.map((m) => ({ saved_search_id: s.id, video_id: m.video_id, player_id: m.player_id })))
        .onConflict((oc) => oc.columns(['saved_search_id', 'video_id']).doNothing())
        .returning(['video_id', 'player_id']).execute();
      if (!inserted.length) return;
      report.hits += inserted.length;
      const newVideos = new Set(inserted.map((i) => i.video_id));
      const players = new Map<string, string>();
      for (const m of matches) if (newVideos.has(m.video_id) && !players.has(m.player_id)) players.set(m.player_id, m.handle);
      // Same preference rule as every other notification (shortlist activity category).
      const prefs = await tx.selectFrom('notification_preferences').selectAll().where('user_id', '=', recipient).executeTakeFirst();
      if (prefs && !shouldDeliver(SAVED_SEARCH_ALERT_KIND, prefs as unknown as NotificationPreferences)) return;
      const named = [...players].slice(0, opts.maxPlayersPerNotification ?? 10);
      await tx.insertInto('notifications').values({
        id: uuidv7(), user_id: recipient, kind: SAVED_SEARCH_ALERT_KIND,
        payload: JSON.stringify({
          savedSearchId: s.id, name: s.name, organizationId: s.organization_id, clips: inserted.length, playersCount: players.size,
          players: named.map(([userId, handle]) => ({ userId, handle })), handle: named[0]?.[1] ?? null,
        }),
      }).execute();
      report.notifications++;
    });
  }
  return report;
}
