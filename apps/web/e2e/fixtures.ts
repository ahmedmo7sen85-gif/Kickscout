/**
 * Test fixtures for screenshots only. They are validated against the shared Zod contracts so the
 * UI is exercised with real response shapes. They never ship in the app.
 */
import * as C from '@fp/contracts';
import type { z } from 'zod';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-08T09:00:00.000Z';
export const MEDIA = 'https://media.test';

const owner = (n: number, handle: string, name: string, extra: Partial<z.infer<typeof C.OwnerSummary>> = {}) =>
  ({ userId: uuid(n), handle, displayName: name, avatarUrl: null, verified: false, isDemo: true, ...extra });

const video = (n: number, o: ReturnType<typeof owner>, v: Partial<z.infer<typeof C.VideoView>>): z.infer<typeof C.VideoView> => ({
  id: uuid(100 + n), owner: o, status: 'published', statusReason: null, moderation: 'safe', title: 'Clip', description: null,
  skill: null, position: null, foot: null, context: 'training', country: null, visibility: 'public', tags: [], hashtags: [],
  playbackUrl: `${MEDIA}/v${n}.mp4`, thumbnailUrl: `${MEDIA}/t${n}.svg`, durationMs: 9000, likes: 0, comments: 0, saves: 0,
  likedByMe: false, savedByMe: false, createdAt: now, publishedAt: now, ...v,
});

const a = owner(1, 'demo_winger', 'Demo Winger', { verified: true });
const b = owner(2, 'demo_keeper', 'Demo Keeper');

export const feed = C.FeedPage.parse({
  tab: 'for_you',
  capability: { key: 'feed.for_you', status: 'live', label: null },
  nextCursor: null,
  items: [
    video(1, a, {
      title: 'Elastico past two defenders', skill: 'elastico', position: 'LW', country: 'EG', hashtags: ['elasticochallenge', 'skills'],
      likes: 1240, comments: 32, saves: 210,
      tags: [
        { skill: 'elastico', name: { en: 'Elastico', ar: 'الإلاستيكو' }, source: 'user', confidence: null, model: null },
        { skill: 'dribbling', name: { en: 'Dribbling', ar: 'المراوغة' }, source: 'ai', confidence: 0.82, model: null },
      ],
    }),
    video(2, b, { title: 'Reflex save drill', skill: 'goalkeeping', position: 'GK', country: 'MA', likes: 88 }),
  ],
});

const card = (o: ReturnType<typeof owner>, p: Partial<z.infer<typeof C.PlayerCard>>): z.infer<typeof C.PlayerCard> => ({
  userId: o.userId, handle: o.handle, displayName: o.displayName, avatarUrl: null, verified: o.verified, isDemo: o.isDemo,
  country: null, position: null, foot: null, ageGroup: null, followers: 0, videos: 0, topSkills: [], ...p,
});

export const radar = C.RadarPage.parse({
  category: 'rising',
  capability: { key: 'talent_radar', status: 'live', label: null },
  disclaimer: {
    en: 'Talent Radar shows who is getting attention right now. It measures engagement, not ability or potential.',
    ar: 'رادار المواهب يُظهر من يلفت الانتباه الآن. إنه يقيس التفاعل، لا القدرة.',
  },
  items: [
    { player: card(a, { country: 'EG', position: 'LW', foot: 'left', followers: 3200, videos: 14, topSkills: ['elastico', 'dribbling'] }),
      reasons: [{ code: 'likes_up', text: { en: 'Likes up 64% this week', ar: 'الإعجابات زادت 64% هذا الأسبوع' } },
        { code: 'skill_focus', text: { en: '4 recent Elastico videos', ar: '4 فيديوهات حديثة في الإلاستيكو' } }] },
    { player: card(b, { country: 'MA', position: 'GK', foot: 'right', followers: 410, videos: 6, topSkills: ['goalkeeping'] }),
      reasons: [{ code: 'followers_growing', text: { en: '38 new followers this week', ar: '38 متابعين جدد هذا الأسبوع' } },
        { code: 'new_player_rising', text: { en: 'New to KICKSCOUT and gaining attention', ar: 'جديد على KICKSCOUT ويلفت الانتباه' } }] },
  ],
});

/** A dark 9:16 poster so screenshots show the layout; not a real player. */
export function posterSvg(n: number): string {
  const hue = n % 2 ? '#1b2a12' : '#121c2a';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 160" width="720" height="1280">
<rect width="90" height="160" fill="${hue}"/><g fill="none" stroke="rgba(255,255,255,.18)" stroke-width=".6">
<rect x="6" y="8" width="78" height="144"/><line x1="6" y1="80" x2="84" y2="80"/><circle cx="45" cy="80" r="16"/></g>
<circle cx="45" cy="104" r="4" fill="#fff"/></svg>`;
}

// ---------------------------------------------------------------- challenges
const challengeCard = (n: number, c: Partial<z.infer<typeof C.ChallengeView>>): z.infer<typeof C.ChallengeView> => ({
  id: uuid(300 + n), slug: `challenge-${n}`, title: { en: 'Juggling King', ar: 'ملك تنطيط الكرة' },
  description: { en: 'Most consecutive controlled touches without the ball touching the ground.', ar: 'أكبر عدد من اللمسات المتتالية دون أن تلمس الكرة الأرض.' },
  skill: 'juggling', hashtag: 'jugglingking', startsAt: '2026-10-05T00:00:00.000Z', endsAt: '2026-10-19T00:00:00.000Z', state: 'active', phase: 'open',
  format: 'weekly', category: 'ball_control', difficulty: 'beginner', ageGroups: ['u13', 'u16', 'u18', 'adult'], featured: false, reward: null,
  thumbnailUrl: null, timezone: 'UTC', participants: 42, entries: 17, votingEnabled: true, isDemo: true, ...c,
});

const juggling = challengeCard(1, { slug: 'juggling-king', featured: true });
const cones = challengeCard(2, {
  slug: 'cone-master', title: { en: 'Cone Master', ar: 'سيد الأقماع' }, category: 'dribbling', hashtag: 'conemaster', participants: 18, entries: 9,
});
const rainbow = challengeCard(3, {
  slug: 'rainbow-flick', title: { en: 'Rainbow Flick', ar: 'الرينبو' }, category: 'freestyle', difficulty: 'advanced', format: 'standard', hashtag: 'rainbowflick',
  participants: 7, entries: 2,
});

export const challengeHub = C.ChallengeHubView.parse({
  featured: juggling, trending: [juggling, cones], newest: [rainbow], endingSoon: [cones], beginner: [juggling, cones], advancedFreestyle: [rainbow],
  upcoming: [], completed: [],
});

export const challengeDetail = C.ChallengeDetailView.parse({
  ...juggling,
  instructions: { en: 'Start with the ball in your hands. Count every controlled touch until the ball hits the ground.', ar: 'ابدأ والكرة في يديك. احسب كل لمسة حتى تسقط الكرة.' },
  equipment: [{ en: 'A size 4 or 5 football', ar: 'كرة مقاس 4 أو 5' }],
  safetyNotes: null,
  recording: { camera: 'side', orientation: 'vertical', continuousTake: true },
  minDurationS: 5, maxDurationS: 120, attemptLimit: 3, retryFailed: true, requiresPartner: false, needsSafetyAck: false,
  rules: [{ kind: 'disqualification', body: { en: 'Cuts or edits in the clip.', ar: 'أي قص أو تعديل في المقطع.' } }],
  rubric: {
    method: 'measured', unit: 'count', direction: 'higher', version: 1, frozen: true, tieBreakers: ['earliest_submission'], minJudges: 1, tolerance: 2,
    attempts: null, summary: { en: 'Score = consecutive controlled touches, counted by a judge.', ar: 'النتيجة = عدد اللمسات المتتالية، يحسبها حكم.' },
    components: [{ key: 'touches', kind: 'measure', label: { en: 'Touches', ar: 'اللمسات' }, max: 100000 }],
  },
  demoVideo: null, resultsPublishedAt: null, indexable: true, me: null,
});

const entry = (rank: number, o: ReturnType<typeof owner>, value: number) => ({
  rank, submissionId: uuid(400 + rank), videoId: uuid(100 + rank), player: o, value, penalties: 0, country: rank === 1 ? 'EG' : null, thumbnailUrl: null,
});
export const challengeLeaderboard = C.LeaderboardView.parse({
  scope: 'overall', kind: 'live', unit: 'count', direction: 'higher', computedAt: now,
  entries: [entry(1, a, 214), entry(2, b, 160)], me: null,
});
export const challengeEntries = C.VideoPage.parse({ items: [], nextCursor: null });
