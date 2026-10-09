'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { dirFor, fmt, getDict, LOCALE_COOKIE, pick, type Dict } from './index';
import type { Bilingual, Locale } from '../types';

export interface I18nValue {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: Dict;
  fmt: typeof fmt;
  pick: (b: Bilingual | null | undefined) => string;
  setLocale: (l: Locale) => void;
  formatNumber: (n: number) => string;
  formatDate: (iso: string) => string;
}

export const I18nContext = createContext<I18nValue | null>(null);

export function createI18nValue(locale: Locale, setLocale: (l: Locale) => void = () => {}): I18nValue {
  const tag = locale;
  const nf = new Intl.NumberFormat(tag, { notation: 'compact', maximumFractionDigits: 1 });
  const df = new Intl.DateTimeFormat(tag, { dateStyle: 'medium' });
  return {
    locale,
    dir: dirFor(locale),
    t: getDict(locale),
    fmt,
    pick: (b) => pick(b, locale),
    setLocale,
    formatNumber: (n) => nf.format(n),
    formatDate: (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : df.format(d); },
  };
}

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const router = useRouter();
  const setLocale = useCallback((l: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = l;
    document.documentElement.dir = dirFor(l);
    router.refresh();
  }, [router]);
  const value = useMemo(() => createI18nValue(locale, setLocale), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n must be used inside I18nProvider');
  return v;
}
