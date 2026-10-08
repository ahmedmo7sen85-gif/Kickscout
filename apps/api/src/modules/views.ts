import type { StoredProfile, Relation, Actor, Position } from '@fp/domain';
import { projectProfile } from '@fp/domain';
import type { Database } from '../db/db.js';
import type { Deps } from '../deps.js';

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

export async function relationTo(db: Database, viewer: Actor | null, subjectId: string): Promise<Relation> {
  if (!viewer) return 'public';
  if (viewer.userId === subjectId) return 'self';
  if (viewer.guardianOf.includes(subjectId)) return 'guardian';
  if (viewer.roles.includes('admin')) return 'admin';
  if (viewer.roles.includes('moderator')) return 'moderator';
  // Verification workflow is Phase 3; until then the scout role is granted only by admins.
  if (viewer.roles.includes('scout') || viewer.roles.includes('academy') || viewer.roles.includes('club')) return 'verified_scout';
  const follows = await db
    .selectFrom('follows')
    .select('follower_id')
    .where('follower_id', '=', viewer.userId)
    .where('followee_id', '=', subjectId)
    .executeTakeFirst();
  return follows ? 'follower' : 'public';
}

export async function profileView(deps: Deps, viewer: Actor | null, userId: string) {
  const stored = await loadStoredProfile(deps.db, userId);
  if (!stored) return null;
  const projected = projectProfile(stored, await relationTo(deps.db, viewer, userId));
  if (!projected) return null;
  const counts = await deps.db
    .selectNoFrom((eb) => [
      eb.selectFrom('follows').select(eb.fn.countAll<string>().as('n')).where('followee_id', '=', userId).as('followers'),
      eb.selectFrom('follows').select(eb.fn.countAll<string>().as('n')).where('follower_id', '=', userId).as('following'),
    ])
    .executeTakeFirstOrThrow();
  const { avatarKey, ...rest } = projected;
  return {
    ...rest,
    avatarUrl: avatarKey ? `${deps.config.CDN_BASE_URL}/${avatarKey}` : null,
    followers: Number(counts.followers),
    following: Number(counts.following),
  };
}
