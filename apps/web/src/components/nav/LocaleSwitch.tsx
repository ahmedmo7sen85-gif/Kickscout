'use client';

import { useId } from 'react';
import { trackClient } from '@/components/Analytics';
import { isLocale, LOCALE_NAMES, LOCALES } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';

/** A labelled native select with every supported locale, each named in its own language. */
export function LocaleSwitch() {
  const { locale, setLocale, t } = useI18n();
  const id = useId();
  return (
    <span className="locale-switch">
      <label htmlFor={id} className="sr-only">{t.common.switchLanguageLabel}</label>
      <select
        id={id}
        className="locale-switch__select"
        value={locale}
        onChange={(e) => {
          const next = e.target.value;
          if (!isLocale(next) || next === locale) return;
          trackClient('locale_changed', { to: next });
          setLocale(next);
        }}
      >
        {LOCALES.map((l) => <option key={l} value={l} lang={l}>{LOCALE_NAMES[l]}</option>)}
      </select>
    </span>
  );
}
