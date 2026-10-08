import { ar } from './ar';
import { en, type Dict } from './en';
import type { Bilingual, Locale } from '../types';

export type { Dict };
export const LOCALES = ['en', 'ar'] as const satisfies readonly Locale[];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'ks_locale';

const DICTS: Record<Locale, Dict> = { en, ar };

export function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'ar';
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
export function pick(b: Bilingual | null | undefined, locale: Locale): string {
  if (!b) return '';
  return b[locale] || b.en;
}
