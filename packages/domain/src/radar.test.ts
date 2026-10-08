import { describe, expect, it } from 'vitest';
import { radarEntry, rankRadar, describeReason } from './radar.js';
import type { RadarStats } from './radar.js';

const base: RadarStats = {
  playerId: 'p', likes7d: 0, likesPrev7d: 0, views7d: 0, viewsPrev7d: 0, newFollowers7d: 0, followers: 0,
  accountAgeDays: 400, challengeEntries7d: 0, saves7d: 0, topSkill: null,
};

describe('Talent Radar', () => {
  it('leaves out players with no engagement signal', () => {
    expect(radarEntry(base)).toBeNull();
    // A skill focus or challenge entry alone is not a reason to be on the radar.
    expect(radarEntry({ ...base, topSkill: { key: 'elastico', videos: 5 }, challengeEntries7d: 3 })).toBeNull();
  });

  it('explains every entry with the signals behind it', () => {
    const e = radarEntry({ ...base, likes7d: 40, likesPrev7d: 10, newFollowers7d: 12, accountAgeDays: 20, topSkill: { key: 'elastico', videos: 3 } });
    expect(e?.reasons.map((r) => r.code)).toEqual(['likes_up', 'followers_growing', 'new_player_rising', 'skill_focus']);
    expect(e?.reasons[0]).toEqual({ code: 'likes_up', percent: 300 });
  });

  it('lets a small fast-growing player outrank a big flat one', () => {
    const small = { ...base, playerId: 'small', likes7d: 30, likesPrev7d: 5, newFollowers7d: 10 };
    const big = { ...base, playerId: 'big', likes7d: 200, likesPrev7d: 190, newFollowers7d: 6, followers: 50000 };
    expect(rankRadar([big, small]).map((e) => e.playerId)).toEqual(['small', 'big']);
  });

  it('writes reasons in English and Arabic', () => {
    const t = describeReason({ code: 'skill_focus', skill: 'nutmeg', videos: 2 }, () => ({ en: 'Nutmeg', ar: 'الكوبري' }));
    expect(t.en).toBe('2 recent Nutmeg videos');
    expect(t.ar).toContain('الكوبري');
  });

  it('ranks hidden gems among small accounts only, and most-saved by saves', () => {
    const small = { ...base, playerId: 'small', likes7d: 10, likesPrev7d: 2, followers: 40 };
    const big = { ...base, playerId: 'big', likes7d: 300, likesPrev7d: 20, followers: 9000, saves7d: 50 };
    expect(rankRadar([small, big], 10, 'hidden_gems').map((e) => e.playerId)).toEqual(['small']);
    const saved = rankRadar([small, big], 10, 'most_saved');
    expect(saved.map((e) => e.playerId)).toEqual(['big']);
    expect(saved[0]?.reasons[0]).toEqual({ code: 'most_saved', saves: 50 });
  });
});
