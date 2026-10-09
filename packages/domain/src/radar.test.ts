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

describe('Talent Radar: more categories, still reasons-based', () => {
  const p = (playerId: string, extra: Partial<RadarStats>) => ({ ...base, playerId, ...extra });

  it('most improved needs a real base last week and shows the growth', () => {
    const climber = p('climber', { likes7d: 12, likesPrev7d: 4 });
    const fromZero = p('fromZero', { likes7d: 9, likesPrev7d: 0 });
    const flat = p('flat', { likes7d: 50, likesPrev7d: 48 });
    const r = rankRadar([climber, fromZero, flat], 10, 'most_improved');
    expect(r.map((e) => e.playerId)).toEqual(['climber']);
    expect(r[0]!.reasons[0]).toEqual({ code: 'engagement_improved', percent: 200 });
  });

  it('top by skill ranks players whose recent clips focus on one skill, with engagement behind them', () => {
    const focused = p('focused', { topSkill: { key: 'nutmeg', videos: 4 }, likes7d: 3 });
    const idle = p('idle', { topSkill: { key: 'nutmeg', videos: 6 } });
    const r = rankRadar([focused, idle], 10, 'top_by_skill');
    expect(r.map((e) => e.playerId)).toEqual(['focused']);
    expect(r[0]!.reasons[0]).toEqual({ code: 'skill_leader', skill: 'nutmeg', videos: 4 });
  });

  it('new to platform: joined in the last 30 days and already noticed', () => {
    const fresh = p('fresh', { accountAgeDays: 6, likes7d: 4 });
    const older = p('older', { accountAgeDays: 60, likes7d: 40, likesPrev7d: 2 });
    const unseen = p('unseen', { accountAgeDays: 3 });
    const r = rankRadar([fresh, older, unseen], 10, 'new_to_platform');
    expect(r.map((e) => e.playerId)).toEqual(['fresh']);
    expect(r[0]!.reasons[0]).toEqual({ code: 'joined_recently', days: 6 });
  });

  it('regional standouts takes the top few per country and never a player who hides their country', () => {
    const mk = (id: string, country: string | null, likes: number) => p(id, { country, likes7d: likes, likesPrev7d: 1 });
    const stats = [mk('eg1', 'EG', 50), mk('eg2', 'EG', 40), mk('eg3', 'EG', 30), mk('eg4', 'EG', 20), mk('sa1', 'SA', 10), mk('hidden', null, 99)];
    const r = rankRadar(stats, 20, 'regional_standouts');
    expect(r.map((e) => e.playerId).sort()).toEqual(['eg1', 'eg2', 'eg3', 'sa1']);
    expect(r.find((e) => e.playerId === 'sa1')!.reasons[0]).toEqual({ code: 'regional_standout', country: 'SA' });
  });

  it('describes every new reason in both languages', () => {
    const name = () => ({ en: 'Nutmeg', ar: 'الكوبري' });
    for (const r of [
      { code: 'engagement_improved', percent: 80 }, { code: 'skill_leader', skill: 'nutmeg', videos: 3 },
      { code: 'joined_recently', days: 4 }, { code: 'regional_standout', country: 'EG' },
    ] as const) {
      const t = describeReason(r, name);
      expect(t.en.length).toBeGreaterThan(5);
      expect(t.ar).toMatch(/[؀-ۿ]/);
      expect(`${t.en} ${t.ar}`).not.toMatch(/rating|potential|score/i);
    }
  });
});
