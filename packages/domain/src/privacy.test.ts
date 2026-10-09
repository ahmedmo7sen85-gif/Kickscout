import { describe, expect, it } from 'vitest';
import { loosensPrivacy, projectProfile } from './privacy.js';
import type { StoredProfile } from './privacy.js';

const base = (over: Partial<StoredProfile> = {}): StoredProfile => ({
  userId: 'u1',
  handle: 'player1',
  displayName: 'Player One',
  bio: null,
  avatarKey: null,
  ageBand: 'u16',
  email: 'p1@example.com',
  region: { macro: 'north-africa', country: 'EG', city: 'cairo' },
  privacy: {
    profileVisibility: 'public', regionPrecision: 'city', directMessages: true, comments: 'everyone',
    allowScoutDiscovery: true, allowContactRequests: true, showCountry: true, showRegion: true, showAge: true, allowAnalytics: true,
  },
  player: { primaryPosition: 'RW', secondaryPositions: [], preferredFoot: 'left' },
  ...over,
});

describe('projectProfile', () => {
  it('never shows a minor’s city, email, age group or DM option to the public', () => {
    const p = projectProfile(base(), 'public')!;
    expect(p.region.city).toBeNull();
    expect(p.region.country).toBe('EG');
    expect(p.email).toBeNull();
    expect(p.ageGroup).toBeNull();
    expect(p.canDirectMessage).toBe(false);
  });

  it('shows a minor’s age group to verified scouts but never contact details', () => {
    const p = projectProfile(base(), 'verified_scout')!;
    expect(p.ageGroup).toBe('u16');
    expect(p.email).toBeNull();
    expect(p.canDirectMessage).toBe(false);
    expect(p.canRequestContact).toBe(true);
  });

  it('shows everything to self and guardian', () => {
    for (const viewer of ['self', 'guardian'] as const) {
      const p = projectProfile(base(), viewer)!;
      expect(p.email).toBe('p1@example.com');
      expect(p.region.city).toBe('cairo');
    }
  });

  it('respects an adult’s own settings', () => {
    const adult = base({ ageBand: 'adult' });
    expect(projectProfile(adult, 'public')!.region.city).toBe('cairo');
    expect(projectProfile(adult, 'public')!.canDirectMessage).toBe(true);
    const coarse = base({ ageBand: 'adult', privacy: { ...adult.privacy, regionPrecision: 'macro' } });
    expect(projectProfile(coarse, 'public')!.region).toEqual({ macro: 'north-africa', country: null, city: null });
  });

  it('hides private and followers-only profiles from those not allowed', () => {
    expect(projectProfile(base({ privacy: { ...base().privacy, profileVisibility: 'private' } }), 'verified_scout')).toBeNull();
    const followersOnly = base({ privacy: { ...base().privacy, profileVisibility: 'followers' } });
    expect(projectProfile(followersOnly, 'public')).toBeNull();
    expect(projectProfile(followersOnly, 'follower')).not.toBeNull();
  });

  it('opens unlisted profiles by direct link like public ones', () => {
    const unlisted = base({ privacy: { ...base().privacy, profileVisibility: 'unlisted' } });
    expect(projectProfile(unlisted, 'public')).not.toBeNull();
  });

  it('applies the show and contact toggles to everyone but self, guardian and admin', () => {
    const adult = base({ ageBand: 'adult' });
    const hidden = base({ ageBand: 'adult', privacy: { ...adult.privacy, showCountry: false, showAge: false, allowContactRequests: false } });
    const p = projectProfile(hidden, 'verified_scout')!;
    expect(p.region).toEqual({ macro: 'north-africa', country: null, city: null });
    expect(p.ageGroup).toBeNull();
    expect(p.canRequestContact).toBe(false);
    expect(projectProfile(hidden, 'self')!.region.country).toBe('EG');
    const noRegion = base({ ageBand: 'adult', privacy: { ...adult.privacy, showRegion: false } });
    expect(projectProfile(noRegion, 'public')!.region).toEqual({ macro: null, country: 'EG', city: null });
    const noDiscovery = base({ ageBand: 'adult', privacy: { ...adult.privacy, allowScoutDiscovery: false } });
    expect(projectProfile(noDiscovery, 'verified_scout')!.canRequestContact).toBe(false);
  });

  it('never lets a toggle hide that a player is a minor from verified scouts', () => {
    const kid = base({ privacy: { ...base().privacy, showAge: false } });
    const p = projectProfile(kid, 'verified_scout')!;
    expect(p.ageGroup).toBeNull();
    expect(p.isMinor).toBe(true);
    // ...and turning a toggle on never shows a minor's city to the public.
    expect(projectProfile(base(), 'public')!.region.city).toBeNull();
  });
});

describe('loosensPrivacy', () => {
  const s = base().privacy;
  it('detects any change that exposes more', () => {
    expect(loosensPrivacy({ ...s, profileVisibility: 'private' }, { ...s, profileVisibility: 'unlisted' })).toBe(true);
    expect(loosensPrivacy({ ...s, showAge: false }, s)).toBe(true);
    expect(loosensPrivacy({ ...s, comments: 'followers' }, s)).toBe(true);
    expect(loosensPrivacy({ ...s, regionPrecision: 'country' }, s)).toBe(true);
    // Turning analytics back on is a loosening (a minor needs their guardian); turning it off is not.
    expect(loosensPrivacy({ ...s, allowAnalytics: false }, s)).toBe(true);
    expect(loosensPrivacy(s, { ...s, allowAnalytics: false })).toBe(false);
  });
  it('treats stricter changes as safe', () => {
    expect(loosensPrivacy(s, { ...s, profileVisibility: 'unlisted', showCountry: false, allowContactRequests: false, comments: 'off' })).toBe(false);
    expect(loosensPrivacy(s, s)).toBe(false);
  });
});
