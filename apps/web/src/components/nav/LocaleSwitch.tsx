'use client';

import { useI18n } from '@/lib/i18n/provider';

export function LocaleSwitch() {
  const { locale, setLocale, t } = useI18n();
  const target = locale === 'ar' ? 'en' : 'ar';
  return (
    <button
      type="button"
      className="locale-switch"
      onClick={() => setLocale(target)}
      aria-label={t.common.switchLanguageLabel}
      lang={target}
    >
      {target === 'ar' ? t.common.switchToArabic : t.common.switchToEnglish}
    </button>
  );
}
