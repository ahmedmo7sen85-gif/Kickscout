import { describe, expect, it } from 'vitest';
import { describeForYouReason, rankForYou } from './recommendations.js';
import type { ForYouCandidate, ForYouSignals } from './recommendations.js';

const now = new Date('2026-10-08T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const clip = (id: string, owner: string, extra: Partial<ForYouCandidate> = {}): ForYouCandidate => ({
  videoId: id, ownerId: owner, ownerHandle: owner, skills: [], position: null, country: null, publishedAt: daysAgo(1), ...extra,
});
const none: ForYouSignals = {
  followed: new Set(), likedSkills: new Map(), likedPositions: new Map(), viewerCountry: null,
  notInterested: { videos: new Set(), players: new Set(), skills: new Set() },
};

describe('For You ranking', () => {
  it('is newest first with no signals, every clip explained', () => {
    const r = rankForYou([clip('old', 'a', { publishedAt: daysAgo(10) }), clip('new', 'b', { publishedAt: daysAgo(0) })], none, now);
    expect(r.map((x) => x.videoId)).toEqual(['new', 'old']);
    expect(r.every((x) => x.reason.code === 'fresh')).toBe(true);
  });

  it('boosts followed players, liked skills and positions and the viewer’s country, with the strongest reason shown', () => {
    const s: ForYouSignals = { ...none, followed: new Set(['star']), likedSkills: new Map([['nutmeg', 3]]), likedPositions: new Map([['GK', 1]]), viewerCountry: 'EG' };
    const r = rankForYou([
      clip('plain', 'x', { publishedAt: daysAgo(0) }),
      clip('region', 'y', { country: 'EG' }),
      clip('keeper', 'z', { position: 'GK' }),
      clip('skill', 'w', { skills: ['nutmeg', 'dribbling'] }),
      clip('followed', 'star'),
    ], s, now);
    expect(r.map((x) => x.videoId)).toEqual(['followed', 'skill', 'keeper', 'region', 'plain']);
    expect(r[0]!.reason).toEqual({ code: 'following', handle: 'star' });
    expect(r[1]!.reason).toEqual({ code: 'liked_skill', skill: 'nutmeg' });
    expect(r[2]!.reason).toEqual({ code: 'liked_position', position: 'GK' });
    expect(r[3]!.reason).toEqual({ code: 'region', country: 'EG' });
  });

  it('honours "Not interested": hides the clip, and its player and skill lose their boost', () => {
    const s: ForYouSignals = {
      ...none, followed: new Set(['star']), likedSkills: new Map([['nutmeg', 5]]),
      notInterested: { videos: new Set(['hidden']), players: new Set(['star']), skills: new Set(['nutmeg']) },
    };
    const r = rankForYou([clip('hidden', 'q'), clip('fromStar', 'star'), clip('nutmegClip', 'k', { skills: ['nutmeg'] }), clip('other', 'm')], s, now);
    expect(r.map((x) => x.videoId)).toEqual(['other', 'nutmegClip', 'fromStar']);
    expect(r.every((x) => x.reason.code === 'fresh')).toBe(true);
  });

  it('keeps variety: no more than two clips from one player in a row', () => {
    const s: ForYouSignals = { ...none, followed: new Set(['star']) };
    const r = rankForYou([1, 2, 3, 4].map((i) => clip(`s${i}`, 'star', { publishedAt: daysAgo(i / 10) })).concat([clip('o1', 'other', { publishedAt: daysAgo(2) })]), s, now);
    expect(r.map((x) => x.videoId)).toEqual(['s1', 's2', 'o1', 's3', 's4']);
  });

  it('lets freshness win over a weak signal after a few weeks', () => {
    const s: ForYouSignals = { ...none, viewerCountry: 'EG' };
    const r = rankForYou([clip('oldLocal', 'a', { country: 'EG', publishedAt: daysAgo(21) }), clip('newOther', 'b', { publishedAt: daysAgo(0) })], s, now);
    expect(r.map((x) => x.videoId)).toEqual(['newOther', 'oldLocal']);
  });

  it('explains reasons in English and Arabic', () => {
    const name = () => ({ en: 'Nutmeg', ar: 'الكوبري' });
    expect(describeForYouReason({ code: 'liked_skill', skill: 'nutmeg' }, name)).toEqual({ en: 'You liked Nutmeg clips', ar: 'أعجبتك مقاطع الكوبري' });
    expect(describeForYouReason({ code: 'following', handle: 'star' }, name).en).toBe('You follow @star');
    expect(describeForYouReason({ code: 'liked_position', position: 'GK' }, name).en).toBe('You liked clips of goalkeepers');
  });
});
