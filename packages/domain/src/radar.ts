/**
 * Talent Radar ranks players by recent engagement momentum and explains why each one appears.
 * It measures attention, not ability: the UI must say so, and no number from here is shown as a
 * rating of the player. The ranking value stays internal.
 */

export interface RadarStats {
  playerId: string;
  likes7d: number;
  likesPrev7d: number;
  views7d: number;
  viewsPrev7d: number;
  newFollowers7d: number;
  followers: number;
  accountAgeDays: number;
  challengeEntries7d: number;
  saves7d: number;
  /** Most-tagged skill in the player's recent videos, with how many recent videos carry it. */
  topSkill: { key: string; videos: number } | null;
}

export type RadarReason =
  | { code: 'likes_up'; percent: number }
  | { code: 'views_up'; percent: number }
  | { code: 'followers_growing'; count: number }
  | { code: 'new_player_rising' }
  | { code: 'skill_focus'; skill: string; videos: number }
  | { code: 'challenge_active'; entries: number }
  | { code: 'most_watched'; views: number }
  | { code: 'most_saved'; saves: number };

export const RADAR_CATEGORIES = ['rising', 'most_watched', 'most_saved', 'new_talents', 'hidden_gems'] as const;
export type RadarCategory = (typeof RADAR_CATEGORIES)[number];

export interface RadarEntry {
  playerId: string;
  reasons: RadarReason[];
  /** Internal sort key. Never displayed. */
  momentum: number;
}

export const RADAR_CONFIG = {
  minLikes7d: 5,
  minGrowthPercent: 25,
  minNewFollowers: 5,
  newPlayerDays: 90,
  minSkillVideos: 2,
  hiddenGemMaxFollowers: 500,
  minViews7d: 20,
  minSaves7d: 3,
};

const growth = (now: number, prev: number) => (prev === 0 ? (now > 0 ? 100 : 0) : Math.round(((now - prev) / prev) * 100));

export function radarEntry(s: RadarStats, cfg = RADAR_CONFIG): RadarEntry | null {
  const reasons: RadarReason[] = [];
  const likeGrowth = growth(s.likes7d, s.likesPrev7d);
  const viewGrowth = growth(s.views7d, s.viewsPrev7d);

  if (s.likes7d >= cfg.minLikes7d && likeGrowth >= cfg.minGrowthPercent) reasons.push({ code: 'likes_up', percent: likeGrowth });
  if (s.views7d >= cfg.minLikes7d * 4 && viewGrowth >= cfg.minGrowthPercent) reasons.push({ code: 'views_up', percent: viewGrowth });
  if (s.newFollowers7d >= cfg.minNewFollowers) reasons.push({ code: 'followers_growing', count: s.newFollowers7d });
  if (s.accountAgeDays <= cfg.newPlayerDays && reasons.length > 0) reasons.push({ code: 'new_player_rising' });
  if (s.topSkill && s.topSkill.videos >= cfg.minSkillVideos && reasons.length > 0) {
    reasons.push({ code: 'skill_focus', skill: s.topSkill.key, videos: s.topSkill.videos });
  }
  if (s.challengeEntries7d > 0 && reasons.length > 0) reasons.push({ code: 'challenge_active', entries: s.challengeEntries7d });

  // Nobody is on the radar without a real engagement signal behind them.
  if (!reasons.some((r) => r.code === 'likes_up' || r.code === 'views_up' || r.code === 'followers_growing')) return null;

  // Relative growth matters more than size, so small players can surface next to big ones.
  const momentum =
    Math.log1p(s.likes7d) * (1 + Math.max(0, likeGrowth) / 100) +
    Math.log1p(s.newFollowers7d) * 2 +
    Math.log1p(s.views7d) * 0.5;
  return { playerId: s.playerId, reasons, momentum: Math.round(momentum * 1000) / 1000 };
}

const byMomentum = (a: RadarEntry, b: RadarEntry) => b.momentum - a.momentum || a.playerId.localeCompare(b.playerId);

/**
 * Ranks one radar category. Every category still requires a real engagement signal and
 * explains itself; none of them is a measure of ability.
 */
export function rankRadar(stats: readonly RadarStats[], limit = 20, category: RadarCategory = 'rising', cfg = RADAR_CONFIG): RadarEntry[] {
  if (category === 'most_watched' || category === 'most_saved') {
    const metric = (s: RadarStats) => (category === 'most_watched' ? s.views7d : s.saves7d);
    const min = category === 'most_watched' ? cfg.minViews7d : cfg.minSaves7d;
    return stats
      .filter((s) => metric(s) >= min)
      .map((s) => {
        const first: RadarReason = category === 'most_watched' ? { code: 'most_watched', views: s.views7d } : { code: 'most_saved', saves: s.saves7d };
        const extra = radarEntry(s, cfg)?.reasons ?? [];
        return { playerId: s.playerId, reasons: [first, ...extra], momentum: metric(s) };
      })
      .sort(byMomentum)
      .slice(0, limit);
  }
  const pool = stats.filter((s) =>
    category === 'new_talents' ? s.accountAgeDays <= cfg.newPlayerDays : category === 'hidden_gems' ? s.followers < cfg.hiddenGemMaxFollowers : true);
  return pool
    .map((s) => radarEntry(s, cfg))
    .filter((e): e is RadarEntry => e !== null)
    .sort(byMomentum)
    .slice(0, limit);
}

/** "Trending because…" sentences for the UI, in English and Arabic. */
export function describeReason(r: RadarReason, skillName: (key: string) => { en: string; ar: string }): { en: string; ar: string } {
  switch (r.code) {
    case 'likes_up':
      return { en: `Likes up ${r.percent}% this week`, ar: `الإعجابات زادت ${r.percent}% هذا الأسبوع` };
    case 'views_up':
      return { en: `Views up ${r.percent}% this week`, ar: `المشاهدات زادت ${r.percent}% هذا الأسبوع` };
    case 'followers_growing':
      return { en: `${r.count} new followers this week`, ar: `${r.count} متابعين جدد هذا الأسبوع` };
    case 'new_player_rising':
      return { en: 'New to KICKSCOUT and gaining attention', ar: 'جديد على KICKSCOUT ويلفت الانتباه' };
    case 'skill_focus': {
      const n = skillName(r.skill);
      return { en: `${r.videos} recent ${n.en} videos`, ar: `${r.videos} فيديوهات حديثة في ${n.ar}` };
    }
    case 'challenge_active':
      return { en: 'Taking part in a challenge', ar: 'يشارك في تحدٍ' };
    case 'most_watched':
      return { en: `Watched by ${r.views} people this week`, ar: `شاهده ${r.views} شخصًا هذا الأسبوع` };
    case 'most_saved':
      return { en: `Saved ${r.saves} times this week`, ar: `تم حفظه ${r.saves} مرة هذا الأسبوع` };
  }
}
