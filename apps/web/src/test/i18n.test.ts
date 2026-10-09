import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ar } from '@/lib/i18n/ar';
import { en } from '@/lib/i18n/en';
import { es } from '@/lib/i18n/es';
import { fr } from '@/lib/i18n/fr';
import { pt } from '@/lib/i18n/pt';
import { dirFor, fmt, getDict, isLocale, LOCALE_NAMES, LOCALES, negotiateLocale, pick } from '@/lib/i18n';

const OTHERS = { ar, es, pt, fr } as const;

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
  it('every locale has exactly the English keys', () => {
    expect(keys(en).length).toBeGreaterThan(300);
    for (const [name, dict] of Object.entries(OTHERS)) expect(keys(dict), name).toEqual(keys(en));
    expect([...LOCALES].sort()).toEqual(['ar', 'en', 'es', 'fr', 'pt']);
    for (const l of LOCALES) expect(getDict(l)).toBeDefined();
  });

  it('every value is a non-empty string in every language', () => {
    for (const dict of [en, ...Object.values(OTHERS)]) {
      for (const [k, v] of leaves(dict)) {
        expect(typeof v, k).toBe('string');
        expect((v as string).trim().length, k).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the same {placeholders} in every language', () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [name, dict] of Object.entries(OTHERS)) {
      const other = new Map(leaves(dict));
      for (const [k, v] of leaves(en)) expect(ph(other.get(k) as string), `${name}.${k}`).toEqual(ph(v as string));
    }
  });

  it('marks the machine translations for review and keeps the brand tagline translated', () => {
    for (const f of ['es', 'pt', 'fr']) {
      const src = readFileSync(fileURLToPath(new URL(`../lib/i18n/${f}.ts`, import.meta.url)), 'utf8');
      expect(src, f).toMatch(/Machine-quality translation/);
    }
    for (const d of [es, pt, fr]) expect(d.common.tagline).not.toBe(en.common.tagline);
    // Language names stay in their own language in every dictionary.
    for (const d of [en, ar, es, pt, fr]) expect([d.common.switchToArabic, d.common.switchToEnglish]).toEqual(['العربية', 'English']);
  });

  it('names each locale in its own language', () => {
    expect(LOCALE_NAMES).toEqual({ en: 'English', ar: 'العربية', es: 'Español', pt: 'Português', fr: 'Français' });
    expect(isLocale('pt')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale('toString')).toBe(false);
  });

  it('only Arabic is right-to-left', () => {
    expect(LOCALES.filter((l) => dirFor(l) === 'rtl')).toEqual(['ar']);
  });

  it('picks the default locale from Accept-Language', () => {
    expect(negotiateLocale(undefined)).toBe('en');
    expect(negotiateLocale('')).toBe('en');
    expect(negotiateLocale('pt-BR,pt;q=0.9,en;q=0.8')).toBe('pt');
    expect(negotiateLocale('de-DE,fr;q=0.7,en;q=0.5')).toBe('fr');
    expect(negotiateLocale('en;q=0.4, es-MX;q=0.9')).toBe('es');
    expect(negotiateLocale('ar-EG')).toBe('ar');
    expect(negotiateLocale('de, ja')).toBe('en');
    expect(negotiateLocale('fr;q=0, *;q=0.1')).toBe('en');
  });

  it('falls back to English for content stored only in English and Arabic', () => {
    const b = { en: 'Skills', ar: 'مهارات' };
    expect(pick(b, 'ar')).toBe('مهارات');
    expect(pick(b, 'fr')).toBe('Skills');
    expect(pick(null, 'es')).toBe('');
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
