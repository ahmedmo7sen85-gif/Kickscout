/**
 * Play: XP, levels, streaks, training drills and who may challenge whom. Shared by the API and
 * the web app. XP counts practice done in KICKSCOUT; it is never a rating of a player's ability
 * and is never shown to scouts or on a public profile.
 *
 * The tactics scenarios (with their correct answers) live in the API only, so the browser cannot
 * read an answer before choosing.
 */
import { isMinor } from './age.js';
import type { AgeBand } from './age.js';

export interface Bi { en: string; ar: string }

// ---------------------------------------------------------------- XP rules

/** Scenarios per tactics round (solo and friend challenge alike). */
export const ROUND_SIZE = 5;
/** XP for the best option, and for a reasonable but weaker one. */
export const XP_BEST = 20;
export const XP_GOOD = 8;
/** Extra XP for picking the best option within this many milliseconds. */
export const FAST_ANSWER_MS = 8_000;
export const XP_FAST_BONUS = 5;
/** Tactics rounds and scan runs that earn XP per UTC day; more can be played for practice. */
export const DAILY_XP_ROUNDS = 10;
export const DAILY_XP_SCAN_RUNS = 3;
/** Reps in one scan run, and XP per correct read. */
export const SCAN_REPS = 10;
export const XP_PER_SCAN_HIT = 3;
/** Winning a friend challenge. A draw gives both players nothing extra. */
export const XP_CHALLENGE_WIN = 25;
/** Days a friend has to play a challenge before it expires. */
export const CHALLENGE_DAYS = 7;

/** XP for one tactics answer: points are 2 (best), 1 (reasonable) or 0. */
export function answerXp(points: number, ms: number): number {
  if (points >= 2) return XP_BEST + (ms <= FAST_ANSWER_MS ? XP_FAST_BONUS : 0);
  if (points === 1) return XP_GOOD;
  return 0;
}

// ---------------------------------------------------------------- levels

export const MAX_LEVEL = 50;

/** Total XP needed to reach `level`: 0, 100, 300, 600, 1000, ... (50 * L * (L - 1)). */
export function xpForLevel(level: number): number {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return 50 * l * (l - 1);
}

export type LevelTier = 'grassroots' | 'academy' | 'reserves' | 'first_team' | 'captain' | 'legend';

export function tierFor(level: number): LevelTier {
  if (level >= 30) return 'legend';
  if (level >= 20) return 'captain';
  if (level >= 15) return 'first_team';
  if (level >= 10) return 'reserves';
  if (level >= 5) return 'academy';
  return 'grassroots';
}

export interface LevelInfo {
  level: number;
  tier: LevelTier;
  /** XP at the start of this level and at the start of the next (equal at the top level). */
  levelStartXp: number;
  nextLevelXp: number;
}

export function levelFor(totalXp: number): LevelInfo {
  const xp = Math.max(0, Math.floor(totalXp));
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level += 1;
  return {
    level,
    tier: tierFor(level),
    levelStartXp: xpForLevel(level),
    nextLevelXp: level < MAX_LEVEL ? xpForLevel(level + 1) : xpForLevel(level),
  };
}

// ---------------------------------------------------------------- streaks

/** UTC calendar day as YYYY-MM-DD. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Consecutive UTC days with any XP, counting back from today, or from yesterday when nothing has
 * been done yet today (the streak is still alive until the day ends).
 */
export function streakDays(activeDays: readonly string[], now: Date): number {
  const days = new Set(activeDays);
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (!days.has(utcDayKey(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let n = 0;
  while (days.has(utcDayKey(cursor))) {
    n += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return n;
}

// ---------------------------------------------------------------- friend challenges

/**
 * Whether two people may play a friend challenge. They must follow each other and neither may have
 * blocked the other. An adult and a minor may only play when the adult is that minor's guardian.
 * Nothing in a challenge carries free text, so this is the only contact it creates.
 */
export function canChallenge(p: {
  mutualFollow: boolean;
  blocked: boolean;
  aBand: AgeBand;
  bBand: AgeBand;
  guardianPair: boolean;
}): { allowed: true } | { allowed: false; code: string; reason: string } {
  if (p.blocked) return { allowed: false, code: 'NOT_FOUND', reason: 'user not found' };
  if (!p.mutualFollow) return { allowed: false, code: 'FRIENDS_ONLY', reason: 'you can only challenge people who follow you back' };
  if (isMinor(p.aBand) !== isMinor(p.bBand) && !p.guardianPair) {
    return { allowed: false, code: 'AGE_GROUP_MISMATCH', reason: 'adults and minors can only play together within a family' };
  }
  return { allowed: true };
}

/** Winner of a finished challenge: more points, then less total time; null for a draw. */
export function challengeWinner(a: { userId: string; points: number; totalMs: number }, b: { userId: string; points: number; totalMs: number }): string | null {
  if (a.points !== b.points) return a.points > b.points ? a.userId : b.userId;
  if (a.totalMs !== b.totalMs) return a.totalMs < b.totalMs ? a.userId : b.userId;
  return null;
}

// ---------------------------------------------------------------- training drills

export type DrillFocus = 'first_touch' | 'passing' | 'dribbling' | 'scanning' | 'finishing' | 'fitness';

export interface TrainingDrill {
  key: string;
  focus: DrillFocus;
  /** Length of the timed block the app counts down, in seconds. */
  seconds: number;
  /** XP for logging it, once per UTC day. */
  xp: number;
  title: Bi;
  /** What to set up and do, step by step. */
  steps: Bi[];
  /** The football-thinking point of the drill. */
  why: Bi;
  /** What to count, if anything; the player may log a number. */
  countLabel: Bi | null;
}

export const TRAINING_DRILLS: readonly TrainingDrill[] = [
  {
    key: 'wall_passes',
    focus: 'passing',
    seconds: 120,
    xp: 30,
    title: { en: 'Wall passes, both feet', ar: 'تمريرات على الحائط بالقدمين' },
    steps: [
      { en: 'Stand 3 to 5 metres from a wall.', ar: 'قف على بعد 3 إلى 5 أمتار من حائط.' },
      { en: 'Pass with the inside of your right foot, control with your left, pass with your left.', ar: 'مرر بباطن القدم اليمنى، واستلم باليسرى، ثم مرر باليسرى.' },
      { en: 'Keep the ball on the ground and count clean passes until the timer ends.', ar: 'أبقِ الكرة على الأرض وعُدّ التمريرات النظيفة حتى ينتهي الوقت.' },
    ],
    why: { en: 'A clean first pass with either foot keeps the game moving and saves you a touch under pressure.', ar: 'التمريرة النظيفة بأي قدم تُبقي اللعب سريعاً وتوفر عليك لمسة تحت الضغط.' },
    countLabel: { en: 'Clean passes', ar: 'تمريرات نظيفة' },
  },
  {
    key: 'cone_weave',
    focus: 'dribbling',
    seconds: 90,
    xp: 30,
    title: { en: 'Cone weave with head up', ar: 'مراوغة بين الأقماع والرأس مرفوع' },
    steps: [
      { en: 'Set 6 cones (or shoes) in a line, one big step apart.', ar: 'ضع 6 أقماع (أو أحذية) في خط، بين كل واحد والآخر خطوة كبيرة.' },
      { en: 'Weave through using small touches with the inside and outside of the foot.', ar: 'راوغ بينها بلمسات صغيرة بباطن القدم وظاهرها.' },
      { en: 'Every second cone, lift your eyes and name something you see. Count full runs.', ar: 'عند كل قمع ثانٍ ارفع عينيك وسمِّ شيئاً تراه. عُدّ الجولات الكاملة.' },
    ],
    why: { en: 'Dribbling with your head up lets you see the next pass before the defender closes you down.', ar: 'المراوغة والرأس مرفوع تجعلك ترى التمريرة التالية قبل أن يضغط عليك المدافع.' },
    countLabel: { en: 'Full runs', ar: 'جولات كاملة' },
  },
  {
    key: 'first_touch_away',
    focus: 'first_touch',
    seconds: 120,
    xp: 30,
    title: { en: 'First touch away from pressure', ar: 'اللمسة الأولى بعيداً عن الضغط' },
    steps: [
      { en: 'Pass against a wall or with a friend.', ar: 'مرر على حائط أو مع صديق.' },
      { en: 'Before the ball arrives, pick a side (imagine a defender on the other).', ar: 'قبل وصول الكرة، اختر جهة (وتخيل مدافعاً في الجهة الأخرى).' },
      { en: 'Take your first touch into that space at an angle, never straight back to where you stood.', ar: 'خذ لمستك الأولى نحو تلك المساحة بزاوية، لا تعيدها إلى مكانك.' },
    ],
    why: { en: 'A directional first touch beats a defender before you have even dribbled.', ar: 'اللمسة الأولى الموجهة تتخطى المدافع قبل أن تبدأ المراوغة أصلاً.' },
    countLabel: { en: 'Good touches', ar: 'لمسات جيدة' },
  },
  {
    key: 'shoulder_checks',
    focus: 'scanning',
    seconds: 120,
    xp: 30,
    title: { en: 'Shoulder checks before receiving', ar: 'النظر خلف الكتف قبل الاستلام' },
    steps: [
      { en: 'Pass with a wall or a friend, standing side-on.', ar: 'مرر على حائط أو مع صديق وأنت تقف بشكل جانبي.' },
      { en: 'Each time the ball travels to you, look over both shoulders before it arrives.', ar: 'في كل مرة تأتي فيها الكرة إليك، انظر خلف كتفيك الاثنين قبل وصولها.' },
      { en: 'If a friend helps, they hold up fingers behind you: call the number before you touch the ball.', ar: 'إن ساعدك صديق، يرفع أصابعه خلفك: قل الرقم قبل أن تلمس الكرة.' },
    ],
    why: { en: 'The best midfielders scan many times before they receive, so they already know their next move.', ar: 'أفضل لاعبي الوسط ينظرون حولهم مرات كثيرة قبل الاستلام، فيعرفون خطوتهم التالية مسبقاً.' },
    countLabel: { en: 'Numbers called right', ar: 'أرقام صحيحة' },
  },
  {
    key: 'finishing_corners',
    focus: 'finishing',
    seconds: 180,
    xp: 30,
    title: { en: 'Pick a corner finishing', ar: 'التسديد نحو الزوايا' },
    steps: [
      { en: 'Mark the two bottom corners of a goal or wall with something you can see.', ar: 'علّم الزاويتين السفليتين لمرمى أو حائط بشيء واضح.' },
      { en: 'From 10 to 12 metres, call a corner out loud, then strike low into it.', ar: 'من مسافة 10 إلى 12 متراً، قل الزاوية بصوت عالٍ ثم سدد كرة أرضية نحوها.' },
      { en: 'Alternate feet. Count shots that hit the corner you called.', ar: 'بدّل القدمين. عُدّ التسديدات التي أصابت الزاوية التي اخترتها.' },
    ],
    why: { en: 'Deciding where before you shoot beats hitting it hard and hoping.', ar: 'تحديد المكان قبل التسديد أفضل من التسديد بقوة على أمل التسجيل.' },
    countLabel: { en: 'Corners hit', ar: 'زوايا مُصابة' },
  },
  {
    key: 'recovery_runs',
    focus: 'fitness',
    seconds: 240,
    xp: 30,
    title: { en: 'Recovery run shuttles', ar: 'جري الارتداد المتكرر' },
    steps: [
      { en: 'Set two markers 20 metres apart.', ar: 'ضع علامتين بينهما 20 متراً.' },
      { en: 'Sprint to the far marker, turn, and jog back. Rest 20 seconds.', ar: 'اركض بأقصى سرعة إلى العلامة البعيدة، استدر، وعُد هرولة. استرح 20 ثانية.' },
      { en: 'On each sprint imagine you lost the ball: get goal-side as fast as you can.', ar: 'في كل ركضة تخيل أنك فقدت الكرة: عُد بين الخصم والمرمى بأسرع ما يمكن.' },
    ],
    why: { en: 'The first five seconds after losing the ball decide whether the other team can counter.', ar: 'الثواني الخمس الأولى بعد فقدان الكرة تحدد ما إذا كان الخصم قادراً على الهجمة المرتدة.' },
    countLabel: { en: 'Sprints', ar: 'ركضات سريعة' },
  },
];

export function drillByKey(key: string): TrainingDrill | undefined {
  return TRAINING_DRILLS.find((d) => d.key === key);
}
