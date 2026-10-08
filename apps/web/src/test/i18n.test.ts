import { describe, expect, it } from 'vitest';
import { ar } from '@/lib/i18n/ar';
import { en } from '@/lib/i18n/en';
import { dirFor, fmt } from '@/lib/i18n';

function keys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k)).sort();
}
function leaves(obj: unknown): [string, unknown][] {
  const out: [string, unknown][] = [];
  const walk = (o: unknown, p: string) => {
    if (typeof o === 'object' && o !== null) for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k);
    else out.push([p, o]);
  };
  walk(obj, '');
  return out;
}

describe('i18n dictionaries', () => {
  it('en and ar have identical keys', () => {
    expect(keys(ar)).toEqual(keys(en));
    expect(keys(en).length).toBeGreaterThan(300);
  });

  it('every value is a non-empty string in both languages', () => {
    for (const dict of [en, ar]) {
      for (const [k, v] of leaves(dict)) {
        expect(typeof v, k).toBe('string');
        expect((v as string).trim().length, k).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the same {placeholders} in both languages', () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    const arLeaves = new Map(leaves(ar));
    for (const [k, v] of leaves(en)) expect(ph(arLeaves.get(k) as string), k).toEqual(ph(v as string));
  });

  it('Arabic is right-to-left and formatting fills placeholders', () => {
    expect(dirFor('ar')).toBe('rtl');
    expect(dirFor('en')).toBe('ltr');
    expect(fmt('{n} videos', { n: 3 })).toBe('3 videos');
  });

  it('uses the brand tagline and hero copy from the spec', () => {
    expect(en.common.tagline).toBe('YOUR SKILL. YOUR MOMENT. GET DISCOVERED.');
    expect([en.landing.heroLine1, en.landing.heroLine2, en.landing.heroLine3]).toEqual(['YOUR SKILL.', 'YOUR MOMENT.', 'GET DISCOVERED.']);
    expect(en.landing.ctaShow).toBe('SHOW YOUR SKILL');
    expect(en.landing.ctaDiscover).toBe('DISCOVER TALENTS');
  });
});
