import type { StoredProfile, Relation, Actor, Position } from '@fp/domain';
import { isMinor, projectProfile } from '@fp/domain';
import type { Database } from '@fp/db';
import type { Deps } from '../deps.js';
import { mediaUrl } from '../platform/storage.js';

export async function regionChain(db: Database, regionId: string | null): Promise<StoredProfile['region']> {
  const out: StoredProfile['region'] = { macro: null, country: null, city: null };
  let id = regionId;
  for (let depth = 0; id && depth < 4; depth++) {
    const r = await db.selectFrom('regions').select(['kind', 'code', 'parent_id']).where('id', '=', id).executeTakeFirst();
    if (!r) break;
    if (r.kind === 'macro') out.macro = r.code;
    else if (r.kind === 'country') out.country = r.code;
    else if (r.kind === 'city') out.city = r.code;
    id = r.parent_id;
  }
  return out;
}

export async function loadStoredProfile(db: Database, userId: string): Promise<StoredProfile | null> {
  const row = await db
    .selectFrom('users')
    .innerJoin('profiles', 'profiles.user_id', 'users.id')
    .innerJoin('age_records', 'age_records.user_id', 'users.id')
    .innerJoin('privacy_settings', 'privacy_settings.user_id', 'users.id')
    .leftJoin('player_profiles', 'player_profiles.user_id', 'users.id')
    .select([
      'users.id', 'users.email', 'users.status', 'profiles.handle', 'profiles.display_name', 'profiles.bio', 'profiles.avatar_key',
      'profiles.region_id', 'age_records.age_band', 'privacy_settings.profile_visibility', 'privacy_settings.region_precision',
      'privacy_settings.direct_messages', 'privacy_settings.comments', 'player_profiles.user_id as player_id',
      'player_profiles.primary_position', 'player_profiles.secondary_positions', 'player_profiles.preferred_foot',
    ])
    .where('users.id', '=', userId)
    .where('users.status', '!=', 'deleted')
    .executeTakeFirst();
  if (!row) return null;
  return {
    userId: row.id,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    avatarKey: row.avatar_key,
    ageBand: row.age_band as StoredProfile['ageBand'],
    email: row.email,
    region: await regionChain(db, row.region_id),
    privacy: {
      profileVisibility: row.profile_visibility as StoredProfile['privacy']['profileVisibility'],
      regionPrecision: row.region_precision as StoredProfile['privacy']['regionPrecision'],
      directMessages: row.direct_messages,
      comments: row.comments as StoredProfile['privacy']['comments'],
    },
    player: row.player_id
      ? {
          primaryPosition: row.primary_position as Position | null,
          secondaryPositions: (row.secondary_positions ?? []) as Position[],
          preferredFoot: row.preferred_foot as 'left' | 'right' | 'both' | null,
        }
      : null,
  };
}

export async function isFollowing(db: Database, followerId: string, followeeId: string) {
  const row = await db.selectFrom('follows').select('follower_id')
    .where('follower_id', '=', followerId).where('followee_id', '=', followeeId).executeTakeFirst();
  return Boolean(row);
}

export async function relationTo(db: Database, viewer: Actor | null, subjectId: string): Promise<Relation> {
  if (!viewer) return 'public';
  if (viewer.userId === subjectId) return 'self';
  if (viewer.guardianOf.includes(subjectId)) return 'guardian';
  if (viewer.roles.includes('admin')) return 'admin';
  if (viewer.roles.includes('moderator')) return 'moderator';
  // The scout role is only granted when staff approve a scout verification request.
  if (viewer.roles.includes('scout')) return 'verified_scout';
  return (await isFollowing(db, viewer.userId, subjectId)) ? 'follower' : 'public';
}

/** Owner, guardian and staff see moderation details; nobody else does. */
export function canSeeInternals(viewer: Actor | null, ownerId: string) {
  return Boolean(viewer && (viewer.userId === ownerId || viewer.guardianOf.includes(ownerId) || viewer.roles.includes('admin') || viewer.roles.includes('moderator')));
}

export async function userStats(db: Database, userId: string) {
  const row = await db
    .selectNoFrom((eb) => [
      eb.selectFrom('follows').select(eb.fn.countAll<string>().as('n')).where('followee_id', '=', userId).as('followers'),
      eb.selectFrom('follows').select(eb.fn.countAll<string>().as('n')).where('follower_id', '=', userId).as('following'),
      eb.selectFrom('videos').select(eb.fn.countAll<string>().as('n')).where('owner_user_id', '=', userId).where('status', '=', 'published').as('videos'),
      eb.selectFrom('likes').innerJoin('videos', 'videos.id', 'likes.video_id').select(eb.fn.countAll<string>().as('n'))
        .where('videos.owner_user_id', '=', userId).where('videos.status', '=', 'published').as('likes'),
    ])
    .executeTakeFirstOrThrow();
  return { followers: Number(row.followers), following: Number(row.following), videos: Number(row.videos), likes: Number(row.likes) };
}

export async function profileView(deps: Deps, viewer: Actor | null, userId: string) {
  const stored = await loadStoredProfile(deps.db, userId);
  if (!stored) return null;
  const relation = await relationTo(deps.db, viewer, userId);
  const projected = projectProfile(stored, relation);
  if (!projected) return null;
  const [stats, extra, followedByMe] = await Promise.all([
    userStats(deps.db, userId),
    deps.db.selectFrom('profiles').innerJoin('users', 'users.id', 'profiles.user_id')
      .select(['profiles.verified_at', 'users.is_demo', 'users.status']).where('profiles.user_id', '=', userId).executeTakeFirstOrThrow(),
    viewer && viewer.userId !== userId ? isFollowing(deps.db, viewer.userId, userId) : Promise.resolve(false),
  ]);
  // Suspended accounts disappear from public view; the person, their guardian and staff still see them.
  if (extra.status === 'suspended' && !['self', 'guardian', 'admin', 'moderator'].includes(relation)) return null;
  const { avatarKey, ...rest } = projected;
  return {
    ...rest,
    avatarUrl: avatarKey ? mediaUrl(deps.config.CDN_BASE_URL, avatarKey) : null,
    verified: extra.verified_at !== null,
    isDemo: extra.is_demo,
    stats,
    followedByMe,
  };
}

/**
 * Player cards for search, radar and scout lists, built in a fixed number of queries.
 * Callers must have already filtered out hidden profiles (see `publicPlayers`).
 */
export async function playerCards(deps: Deps, viewer: Actor | null, userIds: readonly string[]) {
  if (userIds.length === 0) return [];
  const ids = [...userIds];
  const [rows, followers, videos, skills] = await Promise.all([
    deps.db.selectFrom('users')
      .innerJoin('profiles', 'profiles.user_id', 'users.id')
      .innerJoin('age_records', 'age_records.user_id', 'users.id')
      .innerJoin('privacy_settings', 'privacy_settings.user_id', 'users.id')
      .leftJoin('player_profiles', 'player_profiles.user_id', 'users.id')
      .leftJoin('regions', 'regions.id', 'profiles.region_id')
      .select(['users.id', 'users.is_demo', 'profiles.handle', 'profiles.display_name', 'profiles.avatar_key', 'profiles.verified_at',
        'age_records.age_band', 'privacy_settings.region_precision', 'regions.country_code', 'player_profiles.primary_position',
        'player_profiles.preferred_foot'])
      .where('users.id', 'in', ids).execute(),
    deps.db.selectFrom('follows').select(['followee_id', deps.db.fn.countAll<string>().as('n')]).where('followee_id', 'in', ids).groupBy('followee_id').execute(),
    deps.db.selectFrom('videos').select(['owner_user_id', deps.db.fn.countAll<string>().as('n')]).where('owner_user_id', 'in', ids)
      .where('status', '=', 'published').groupBy('owner_user_id').execute(),
    deps.db.selectFrom('video_skills').innerJoin('videos', 'videos.id', 'video_skills.video_id')
      .select(['videos.owner_user_id', 'video_skills.skill_key', deps.db.fn.count<string>('video_skills.video_id').distinct().as('n')])
      .where('videos.owner_user_id', 'in', ids).where('videos.status', '=', 'published').where('video_skills.status', '=', 'active')
      .groupBy(['videos.owner_user_id', 'video_skills.skill_key']).execute(),
  ]);
  const f = new Map(followers.map((r) => [r.followee_id, Number(r.n)]));
  const v = new Map(videos.map((r) => [r.owner_user_id, Number(r.n)]));
  const top = new Map<string, { key: string; n: number }[]>();
  for (const s of skills) (top.get(s.owner_user_id) ?? top.set(s.owner_user_id, []).get(s.owner_user_id)!).push({ key: s.skill_key, n: Number(s.n) });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const privilegedViewer = Boolean(viewer && (viewer.roles.includes('scout') || viewer.roles.includes('admin') || viewer.roles.includes('moderator')));

  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    const minor = isMinor(r.age_band as never);
    const ageVisible = !minor || privilegedViewer || viewer?.userId === id || Boolean(viewer?.guardianOf.includes(id));
    return [{
      userId: r.id,
      handle: r.handle,
      displayName: r.display_name,
      avatarUrl: r.avatar_key ? mediaUrl(deps.config.CDN_BASE_URL, r.avatar_key) : null,
      verified: r.verified_at !== null,
      isDemo: r.is_demo,
      country: r.region_precision === 'macro' ? null : r.country_code,
      position: r.primary_position as Position | null,
      foot: r.preferred_foot as 'left' | 'right' | 'both' | null,
      ageGroup: ageVisible ? (r.age_band as never) : null,
      followers: f.get(id) ?? 0,
      videos: v.get(id) ?? 0,
      topSkills: (top.get(id) ?? []).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)).slice(0, 3).map((s) => s.key as never),
    }];
  });
}
