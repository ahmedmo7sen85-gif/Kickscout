/**
 * The 20 promotional clips. They are AI-generated demonstrations (Wan2.2), never footage of real
 * players, and every place that shows one must label it as such. Files live under
 * NEXT_PUBLIC_PROMO_BASE_URL as `<stem>.mp4` with a `<stem>.jpg` poster; a missing file falls back
 * to a drawn placeholder (see components/landing/PromoClip).
 */
import { publicEnv } from './env';
import type { Bilingual, SkillKey } from './types';

export const PROMO_STEMS = [
  '01_stepover', '02_elastico', '03_rainbow_flick', '04_cruyff_turn', '05_roulette', '06_nutmeg', '07_la_croqueta',
  '08_first_touch', '09_juggling', '10_ball_mastery', '11_outside_foot_pass', '12_long_range_shot', '13_free_kick',
  '14_volley', '15_speed_dribble', '16_1v1_showcase', '17_ball_recovery', '18_skill_combo', '19_talent_showcase',
  '20_hero_your_skill_your_moment',
] as const;
export type PromoStem = (typeof PROMO_STEMS)[number];

export interface PromoClip {
  stem: PromoStem;
  /** Two-digit order number, e.g. "07". */
  n: string;
  label: Bilingual;
  /** Skill family label for the overlay chip. */
  category: Bilingual;
  skill: SkillKey | null;
  orientation: 'portrait' | 'landscape';
  /** Always true: promo media is AI-generated demo content. */
  aiGenerated: true;
  isHero: boolean;
}

type Row = [PromoStem, string, string, string, string, SkillKey | null];
const ROWS: Row[] = [
  ['01_stepover', 'Step-over', 'المقص', 'Dribbling', 'المراوغة', 'step_over'],
  ['02_elastico', 'Elastico', 'الإلاستيكو', 'Dribbling', 'المراوغة', 'elastico'],
  ['03_rainbow_flick', 'Rainbow flick', 'قوس قزح', 'Freestyle', 'الفري ستايل', 'rainbow_flick'],
  ['04_cruyff_turn', 'Cruyff turn', 'دوران كرويف', 'Dribbling', 'المراوغة', 'cruyff_turn'],
  ['05_roulette', 'Roulette', 'الروليت', 'Dribbling', 'المراوغة', 'roulette'],
  ['06_nutmeg', 'Nutmeg', 'الكوبري', '1v1', 'واحد ضد واحد', 'nutmeg'],
  ['07_la_croqueta', 'La croqueta', 'لا كروكيتا', 'Dribbling', 'المراوغة', 'la_croqueta'],
  ['08_first_touch', 'First touch', 'اللمسة الأولى', 'Ball control', 'التحكم بالكرة', 'first_touch'],
  ['09_juggling', 'Juggling', 'تنطيط الكرة', 'Freestyle', 'الفري ستايل', 'juggling'],
  ['10_ball_mastery', 'Ball mastery', 'إتقان الكرة', 'Ball control', 'التحكم بالكرة', 'ball_mastery'],
  ['11_outside_foot_pass', 'Outside-foot pass', 'تمريرة بخارج القدم', 'Passing', 'التمرير', 'passing'],
  ['12_long_range_shot', 'Long-range shot', 'تسديدة بعيدة', 'Shooting', 'التسديد', 'long_range_shooting'],
  ['13_free_kick', 'Free kick', 'ركلة حرة', 'Set pieces', 'الكرات الثابتة', 'free_kick'],
  ['14_volley', 'Volley', 'الطائرة', 'Shooting', 'التسديد', 'volley'],
  ['15_speed_dribble', 'Speed dribble', 'مراوغة بسرعة', 'Speed', 'السرعة', 'speed'],
  ['16_1v1_showcase', '1v1 showcase', 'مواجهة فردية', '1v1', 'واحد ضد واحد', 'one_v_one'],
  ['17_ball_recovery', 'Ball recovery', 'استخلاص الكرة', 'Defending', 'الدفاع', 'defending'],
  ['18_skill_combo', 'Skill combo', 'مهارات متتالية', 'Dribbling', 'المراوغة', 'skill_combo'],
  ['19_talent_showcase', 'Talent showcase', 'استعراض موهبة', 'Showcase', 'استعراض', null],
  ['20_hero_your_skill_your_moment', 'Your skill. Your moment.', 'مهارتك. لحظتك.', 'Hero film', 'الفيلم الرئيسي', null],
];

export const PROMO_CLIPS: readonly PromoClip[] = ROWS.map(([stem, en, ar, cEn, cAr, skill]) => ({
  stem,
  n: stem.slice(0, 2),
  label: { en, ar },
  category: { en: cEn, ar: cAr },
  skill,
  orientation: stem.startsWith('20_') ? 'landscape' : 'portrait',
  aiGenerated: true,
  isHero: stem.startsWith('20_'),
}));

export const HERO_CLIP: PromoClip = PROMO_CLIPS[PROMO_CLIPS.length - 1]!;
export const REEL_CLIPS: readonly PromoClip[] = PROMO_CLIPS.filter((c) => !c.isHero);

const byStem = new Map(PROMO_CLIPS.map((c) => [c.stem, c]));
export function promoClip(stem: PromoStem): PromoClip {
  return byStem.get(stem)!;
}

export function promoVideoUrl(stem: PromoStem, base = publicEnv.promoBaseUrl): string {
  return `${base}/${stem}.mp4`;
}
export function promoPosterUrl(stem: PromoStem, base = publicEnv.promoBaseUrl): string {
  return `${base}/${stem}.jpg`;
}

export const SHOWCASE_STEMS: readonly PromoStem[] = ['15_speed_dribble', '16_1v1_showcase', '18_skill_combo', '19_talent_showcase'];
export const CHALLENGE_EXAMPLES: readonly { tag: string; stem: PromoStem; text: Bilingual }[] = [
  { tag: '#ELASTICOCHALLENGE', stem: '02_elastico', text: { en: 'Outside, inside, gone. One clean elastico past a cone or a defender.', ar: 'خارج، داخل، وانطلق. إلاستيكو نظيف أمام قمع أو مدافع.' } },
  { tag: '#FREESTYLECHALLENGE', stem: '09_juggling', text: { en: 'Thirty seconds of keepy-ups. Use every surface except your hands.', ar: 'ثلاثون ثانية من تنطيط الكرة. استخدم كل شيء إلا يديك.' } },
  { tag: '#FIRSTTOUCHCHALLENGE', stem: '08_first_touch', text: { en: 'Kill a high ball dead with one touch. Film it from the side.', ar: 'روّض كرة عالية بلمسة واحدة. صوّرها من الجانب.' } },
];
