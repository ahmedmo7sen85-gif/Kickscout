import { describe, expect, it } from 'vitest';
import { projectProfile } from './privacy.js';
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
  privacy: { profileVisibility: 'public', regionPrecision: 'city', directMessages: true, comments: 'everyone' },
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
});
