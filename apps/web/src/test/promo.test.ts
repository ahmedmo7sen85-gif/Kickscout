import { describe, expect, it } from 'vitest';
import { HERO_CLIP, PROMO_CLIPS, PROMO_STEMS, promoPosterUrl, promoVideoUrl, REEL_CLIPS } from '@/lib/promo';

const EXPECTED = [
  '01_stepover', '02_elastico', '03_rainbow_flick', '04_cruyff_turn', '05_roulette', '06_nutmeg', '07_la_croqueta',
  '08_first_touch', '09_juggling', '10_ball_mastery', '11_outside_foot_pass', '12_long_range_shot', '13_free_kick',
  '14_volley', '15_speed_dribble', '16_1v1_showcase', '17_ball_recovery', '18_skill_combo', '19_talent_showcase',
  '20_hero_your_skill_your_moment',
];

describe('promo media config', () => {
  it('has exactly the 20 stems in order', () => {
    expect([...PROMO_STEMS]).toEqual(EXPECTED);
    expect(PROMO_CLIPS.map((c) => c.stem)).toEqual(EXPECTED);
  });

  it('puts the hero last and only the hero is landscape', () => {
    expect(PROMO_CLIPS.at(-1)?.stem).toBe('20_hero_your_skill_your_moment');
    expect(HERO_CLIP.isHero).toBe(true);
    expect(PROMO_CLIPS.filter((c) => c.isHero)).toHaveLength(1);
    expect(PROMO_CLIPS.filter((c) => c.orientation === 'landscape').map((c) => c.stem)).toEqual(['20_hero_your_skill_your_moment']);
    expect(REEL_CLIPS).toHaveLength(19);
  });

  it('labels every clip as AI-generated, in both languages', () => {
    for (const c of PROMO_CLIPS) {
      expect(c.aiGenerated).toBe(true);
      expect(c.label.en.length).toBeGreaterThan(0);
      expect(c.label.ar.length).toBeGreaterThan(0);
      expect(c.n).toBe(c.stem.slice(0, 2));
    }
  });

  it('builds .mp4 and .jpg poster URLs from the base URL', () => {
    expect(promoVideoUrl('02_elastico', 'https://cdn.example.com/promo')).toBe('https://cdn.example.com/promo/02_elastico.mp4');
    expect(promoPosterUrl('02_elastico', 'https://cdn.example.com/promo')).toBe('https://cdn.example.com/promo/02_elastico.jpg');
    expect(promoVideoUrl('20_hero_your_skill_your_moment')).toMatch(/\/20_hero_your_skill_your_moment\.mp4$/);
  });
});
