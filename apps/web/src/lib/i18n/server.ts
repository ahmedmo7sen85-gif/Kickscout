import 'server-only';
import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, getDict, isLocale, LOCALE_COOKIE } from './index';
import type { Locale } from '../types';

export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const v = store.get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

export async function getServerDict() {
  const locale = await getLocale();
  return { locale, t: getDict(locale) };
}
