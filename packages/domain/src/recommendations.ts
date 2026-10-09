/**
 * For You personalisation. Transparent on purpose: a clip is ranked only by signals the viewer gave
 * us and can see (players they follow, skills and positions of clips they liked or saved, their
 * country) plus freshness. No watch time, no engagement prediction, no streaks or variable rewards.
 * Every item carries the one reason it was shown, and "Not interested" always wins over a boost.
 */
import { POSITION_NAMES } from './nl-query.js';
import type { Position } from './taxonomy.js';

export interface ForYouCandidate {
  videoId: string;
  ownerId: string;
  ownerHandle: string;
  /** Active skill tags of the clip (AI or player) and the uploader's chosen skill. */
  skills: readonly string[];
  position: string | null;
  /** Owner's country, only when they show it. */
  country: string | null;
  publishedAt: Date;
}

export interface ForYouSignals {
  followed: ReadonlySet<string>;
  /** Skill -> how many liked or saved clips carry it (since the last history reset). */
  likedSkills: ReadonlyMap<string, number>;
  likedPositions: ReadonlyMap<string, number>;
  viewerCountry: string | null;
  notInterested: { videos: ReadonlySet<string>; players: ReadonlySet<string>; skills: ReadonlySet<string> };
}

export type ForYouReason =
  | { code: 'following'; handle: string }
  | { code: 'liked_skill'; skill: string }
  | { code: 'liked_position'; position: string }
  | { code: 'region'; country: string }
  | { code: 'fresh' };

export interface RankedForYou {
  videoId: string;
  reason: ForYouReason;
  /** Internal sort key; never shown. */
  score: number;
}

export const FOR_YOU_WEIGHTS = {
  following: 3,
  likedSkill: 2,
  likedPosition: 1,
  region: 1,
  notInterestedPlayer: -4,
  notInterestedSkill: -2,
  /** Points lost per week of age, so the feed keeps moving. */
  agePerWeek: 1,
  /** No more than this many clips from one player in a row. */
  maxRunPerPlayer: 2,
};

export function rankForYou(cands: readonly ForYouCandidate[], s: ForYouSignals, now: Date, w = FOR_YOU_WEIGHTS): RankedForYou[] {
  const scored = cands
    .filter((c) => !s.notInterested.videos.has(c.videoId))
    .map((c) => {
      const parts: { points: number; reason: ForYouReason }[] = [];
      const hiddenPlayer = s.notInterested.players.has(c.ownerId);
      if (hiddenPlayer) parts.push({ points: w.notInterestedPlayer, reason: { code: 'fresh' } });
      else if (s.followed.has(c.ownerId)) parts.push({ points: w.following, reason: { code: 'following', handle: c.ownerHandle } });
      const skills = [...new Set(c.skills)];
      if (skills.some((k) => s.notInterested.skills.has(k))) parts.push({ points: w.notInterestedSkill, reason: { code: 'fresh' } });
      const liked = skills.filter((k) => !s.notInterested.skills.has(k) && (s.likedSkills.get(k) ?? 0) > 0)
        .sort((a, b) => (s.likedSkills.get(b) ?? 0) - (s.likedSkills.get(a) ?? 0) || a.localeCompare(b));
      if (liked.length && !hiddenPlayer) parts.push({ points: w.likedSkill, reason: { code: 'liked_skill', skill: liked[0]! } });
      if (c.position && (s.likedPositions.get(c.position) ?? 0) > 0 && !hiddenPlayer) {
        parts.push({ points: w.likedPosition, reason: { code: 'liked_position', position: c.position } });
      }
      if (c.country && s.viewerCountry && c.country === s.viewerCountry && !hiddenPlayer) {
        parts.push({ points: w.region, reason: { code: 'region', country: c.country } });
      }
      const ageWeeks = Math.max(0, now.getTime() - c.publishedAt.getTime()) / (7 * 86_400_000);
      const score = parts.reduce((n, p) => n + p.points, 0) - ageWeeks * w.agePerWeek;
      const best = parts.filter((p) => p.points > 0).sort((a, b) => b.points - a.points)[0];
      return { c, score: Math.round(score * 1000) / 1000, reason: best?.reason ?? ({ code: 'fresh' } as const) };
    })
    .sort((a, b) => b.score - a.score || b.c.publishedAt.getTime() - a.c.publishedAt.getTime() || a.c.videoId.localeCompare(b.c.videoId));

  // Variety: never more than `maxRunPerPlayer` clips of one player in a row (the next best clip moves up).
  const out: typeof scored = [];
  const rest = [...scored];
  while (rest.length) {
    const run = out.slice(-w.maxRunPerPlayer);
    const blocked = run.length === w.maxRunPerPlayer && run.every((x) => x.c.ownerId === run[0]!.c.ownerId) ? run[0]!.c.ownerId : null;
    const i = blocked ? rest.findIndex((x) => x.c.ownerId !== blocked) : 0;
    out.push(...rest.splice(i === -1 ? 0 : i, 1));
  }
  return out.map((x) => ({ videoId: x.c.videoId, reason: x.reason, score: x.score }));
}

/** "Why am I seeing this?" in English and Arabic. */
export function describeForYouReason(r: ForYouReason, skillName: (key: string) => { en: string; ar: string }): { en: string; ar: string } {
  switch (r.code) {
    case 'following':
      return { en: `You follow @${r.handle}`, ar: `أنت تتابع @${r.handle}` };
    case 'liked_skill': {
      const n = skillName(r.skill);
      return { en: `You liked ${n.en} clips`, ar: `أعجبتك مقاطع ${n.ar}` };
    }
    case 'liked_position': {
      const n = POSITION_NAMES[r.position as Position] ?? { en: r.position, ar: r.position };
      return { en: `You liked clips of ${n.en.toLowerCase()}s`, ar: `أعجبتك مقاطع لاعبي ${n.ar}` };
    }
    case 'region':
      return { en: `A player from your country (${r.country})`, ar: `لاعب من بلدك (${r.country})` };
    case 'fresh':
      return { en: 'A recent clip on KICKSCOUT', ar: 'مقطع حديث على KICKSCOUT' };
  }
}

/** The order the feed uses when personalisation is off: newest first, with the same plain reason. */
export const NEWEST_REASON: ForYouReason = { code: 'fresh' };
