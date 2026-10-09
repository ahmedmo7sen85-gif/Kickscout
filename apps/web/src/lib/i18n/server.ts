import 'server-only';
import { cookies, headers } from 'next/headers';
import { getDict, isLocale, LOCALE_COOKIE, negotiateLocale } from './index';
import type { Locale } from '../types';

/** The chosen locale: the switcher's cookie first, then the browser's Accept-Language, then English. */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const v = store.get(LOCALE_COOKIE)?.value;
  if (isLocale(v)) return v;
  const h = await headers();
  return negotiateLocale(h.get('accept-language'));
}

export async function getServerDict() {
  const locale = await getLocale();
  return { locale, t: getDict(locale) };
}
