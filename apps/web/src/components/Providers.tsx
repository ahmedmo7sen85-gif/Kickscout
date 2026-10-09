'use client';

import type { ReactNode } from 'react';
import { PageViewTracker } from '@/components/Analytics';
import { ToastProvider } from '@/components/ui/Toast';
import { AuthProvider } from '@/lib/auth';
import { FlagsProvider } from '@/lib/flags';
import { I18nProvider } from '@/lib/i18n/provider';
import type { Locale } from '@/lib/types';

export function Providers({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <I18nProvider locale={locale}>
      <ToastProvider>
        <AuthProvider>
          <FlagsProvider>
            <PageViewTracker />
            {children}
          </FlagsProvider>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
