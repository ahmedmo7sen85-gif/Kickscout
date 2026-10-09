import { ar } from './ar';
import { en, type Dict } from './en';
import { es } from './es';
import { fr } from './fr';
import { pt } from './pt';
import type { Bilingual, Locale } from '../types';

export type { Dict };
export const LOCALES = ['en', 'ar', 'es', 'pt', 'fr'] as const satisfies readonly Locale[];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'ks_locale';

/** Each locale's own name, shown in the switcher in that language (an endonym). */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  ar: 'العربية',
  es: 'Español',
  pt: 'Português',
  fr: 'Français',
};

const DICTS: Record<Locale, Dict> = { en, ar, es, pt, fr };

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}
export function getDict(locale: Locale): Dict {
  return DICTS[locale];
}
export function dirFor(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}
/** Replaces `{name}` placeholders. */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
/** Content stored in English and Arabic only (challenges, plans): other locales fall back to English. */
export function pick(b: Bilingual | null | undefined, locale: Locale): string {
  if (!b) return '';
  return (b as Record<string, string | undefined>)[locale] || b.en;
}

/**
 * The best supported locale for an `Accept-Language` header (RFC 9110 weights, primary subtag
 * match, so `pt-BR` gives `pt`). Falls back to the default for a missing or unmatched header.
 */
export function negotiateLocale(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const ranked = header.split(',').slice(0, 20).map((part, i) => {
    const [tag = '', ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    return { lang: tag.trim().toLowerCase().split('-')[0] ?? '', weight: Number.isFinite(weight) ? weight : 0, i };
  }).filter((r) => r.weight > 0).sort((a, b) => b.weight - a.weight || a.i - b.i);
  for (const r of ranked) if (isLocale(r.lang)) return r.lang;
  return DEFAULT_LOCALE;
}
