/**
 * Profile projection. Every read of another user's profile goes through `projectProfile`, which
 * returns only what this viewer may see. Minors get stricter rules than their own settings allow.
 */
import { isMinor } from './age.js';
import type { AgeBand } from './age.js';
import type { Position } from './taxonomy.js';

export type Relation = 'self' | 'guardian' | 'admin' | 'moderator' | 'verified_scout' | 'follower' | 'public';
export type RegionPrecision = 'macro' | 'country' | 'city';
/** 'unlisted' profiles open by direct link but are never listed in feeds, search, Discover, radar or scout search. */
export type ProfileVisibility = 'public' | 'unlisted' | 'followers' | 'private';
export type CommentsSetting = 'everyone' | 'followers' | 'off';

export interface PrivacySettings {
  profileVisibility: ProfileVisibility;
  regionPrecision: RegionPrecision;
  directMessages: boolean;
  comments: CommentsSetting;
  /** Off: never listed as a player anywhere (search, Discover, radar, scout search) and no scout actions. */
  allowScoutDiscovery: boolean;
  /** Off: scouts cannot send contact requests, whatever the scout-contact consent says. */
  allowContactRequests: boolean;
  showCountry: boolean;
  /** The broad region and city. */
  showRegion: boolean;
  showAge: boolean;
}

export interface StoredProfile {
  userId: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarKey: string | null;
  ageBand: AgeBand;
  email: string | null;
  region: { macro: string | null; country: string | null; city: string | null };
  privacy: PrivacySettings;
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
  const s = p.privacy;

  // 'public' and 'unlisted' both open by direct link; keeping unlisted profiles out of lists is the
  // job of the listing queries.
  if (!privileged && viewer !== 'moderator') {
    if (s.profileVisibility === 'private') return null;
    if (s.profileVisibility === 'followers' && viewer !== 'follower') return null;
  }

  // A minor's region is never more precise than country for anyone outside self, guardian and admin,
  // whatever their own setting says.
  let precision: RegionPrecision = privileged ? 'city' : s.regionPrecision;
  if (minor && !privileged && PRECISION_RANK[precision] > PRECISION_RANK.country) precision = 'country';
  const region = clampRegion(p.region, precision);
  // The show_* toggles only ever hide more. Hiding the country hides the city under it too.
  if (!privileged) {
    if (!s.showRegion) Object.assign(region, { macro: null, city: null });
    if (!s.showCountry) Object.assign(region, { country: null, city: null });
  }

  const ageVisible = privileged || viewer === 'moderator' || (s.showAge && (viewer === 'verified_scout' || !minor));
  // Hiding the age group never hides the fact that a player is a minor from the people who must know it.
  const minorFlagVisible = ageVisible || (minor && viewer === 'verified_scout');

  return {
    userId: p.userId,
    handle: p.handle,
    displayName: p.displayName,
    bio: p.bio,
    avatarKey: p.avatarKey,
    ageGroup: ageVisible ? p.ageBand : null,
    isMinor: minorFlagVisible ? minor : null,
    email: privileged ? p.email : null,
    region,
    player: p.player,
    // Direct messages to minors are always off. Contact with a minor goes through the guardian.
    canDirectMessage: viewer !== 'self' && !minor && s.directMessages,
    canRequestContact: viewer === 'verified_scout' && s.allowContactRequests && s.allowScoutDiscovery,
  };
}

const VISIBILITY_RANK: Record<ProfileVisibility, number> = { private: 0, followers: 1, unlisted: 2, public: 3 };
const COMMENTS_RANK: Record<CommentsSetting, number> = { off: 0, followers: 1, everyone: 2 };
const TOGGLES = ['directMessages', 'allowScoutDiscovery', 'allowContactRequests', 'showCountry', 'showRegion', 'showAge'] as const;

/** True when `next` exposes anything `current` did not. For a minor only the guardian may loosen. */
export function loosensPrivacy(current: PrivacySettings, next: PrivacySettings): boolean {
  return VISIBILITY_RANK[next.profileVisibility] > VISIBILITY_RANK[current.profileVisibility]
    || PRECISION_RANK[next.regionPrecision] > PRECISION_RANK[current.regionPrecision]
    || COMMENTS_RANK[next.comments] > COMMENTS_RANK[current.comments]
    || TOGGLES.some((k) => next[k] && !current[k]);
}
