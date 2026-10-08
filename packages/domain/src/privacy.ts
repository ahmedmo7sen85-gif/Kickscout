/**
 * Profile projection. Every read of another user's profile goes through `projectProfile`, which
 * returns only what this viewer may see. Minors get stricter rules than their own settings allow.
 */
import { isMinor } from './age.js';
import type { AgeBand } from './age.js';
import type { Position } from './taxonomy.js';

export type Relation = 'self' | 'guardian' | 'admin' | 'moderator' | 'verified_scout' | 'follower' | 'public';
export type RegionPrecision = 'macro' | 'country' | 'city';

export interface StoredProfile {
  userId: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarKey: string | null;
  ageBand: AgeBand;
  email: string | null;
  region: { macro: string | null; country: string | null; city: string | null };
  privacy: {
    profileVisibility: 'public' | 'followers' | 'private';
    regionPrecision: RegionPrecision;
    directMessages: boolean;
    comments: 'everyone' | 'followers' | 'off';
  };
  player: {
    primaryPosition: Position | null;
    secondaryPositions: Position[];
    preferredFoot: 'left' | 'right' | 'both' | null;
  } | null;
}

export interface ProjectedProfile {
  userId: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarKey: string | null;
  /** Only shown where age group is a legitimate need (self, guardian, staff, verified scouts) or for adults. */
  ageGroup: AgeBand | null;
  isMinor: boolean | null;
  email: string | null;
  region: { macro: string | null; country: string | null; city: string | null };
  player: StoredProfile['player'];
  canDirectMessage: boolean;
  canRequestContact: boolean;
}

const PRIVILEGED: ReadonlySet<Relation> = new Set(['self', 'guardian', 'admin']);
const PRECISION_RANK: Record<RegionPrecision, number> = { macro: 0, country: 1, city: 2 };

function clampRegion(region: StoredProfile['region'], precision: RegionPrecision): StoredProfile['region'] {
  const rank = PRECISION_RANK[precision];
  return {
    macro: region.macro,
    country: rank >= 1 ? region.country : null,
    city: rank >= 2 ? region.city : null,
  };
}

/** Returns null when the viewer may not see the profile at all. */
export function projectProfile(p: StoredProfile, viewer: Relation): ProjectedProfile | null {
  const minor = isMinor(p.ageBand);
  const privileged = PRIVILEGED.has(viewer);

  if (!privileged && viewer !== 'moderator') {
    if (p.privacy.profileVisibility === 'private') return null;
    if (p.privacy.profileVisibility === 'followers' && viewer !== 'follower') return null;
  }

  // A minor's region is never more precise than country for anyone outside self, guardian and admin,
  // whatever their own setting says.
  let precision: RegionPrecision = privileged ? 'city' : p.privacy.regionPrecision;
  if (minor && !privileged && PRECISION_RANK[precision] > PRECISION_RANK.country) precision = 'country';

  const ageVisible = privileged || viewer === 'moderator' || viewer === 'verified_scout' || !minor;

  return {
    userId: p.userId,
    handle: p.handle,
    displayName: p.displayName,
    bio: p.bio,
    avatarKey: p.avatarKey,
    ageGroup: ageVisible ? p.ageBand : null,
    isMinor: ageVisible ? minor : null,
    email: privileged ? p.email : null,
    region: clampRegion(p.region, precision),
    player: p.player,
    // Direct messages to minors are always off. Contact with a minor goes through the guardian.
    canDirectMessage: viewer !== 'self' && !minor && p.privacy.directMessages,
    canRequestContact: viewer === 'verified_scout',
  };
}
