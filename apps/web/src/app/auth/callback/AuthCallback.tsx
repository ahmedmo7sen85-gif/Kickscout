'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/States';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/provider';
import { readNext, withNext } from '@/lib/next-path';
import { getSupabase } from '@/lib/supabase';

/** OAuth / email-confirmation landing: exchange the code, then go to onboarding or home. */
export function AuthCallback() {
  const { t } = useI18n();
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const sb = getSupabase();
    if (!sb) { setFailed(true); return; }
    const code = new URL(window.location.href).searchParams.get('code');
    const next = readNext();
    (async () => {
      if (code) {
        const { error } = await sb.auth.exchangeCodeForSession(code);
        if (error) { setFailed(true); return; }
      }
      const { data } = await sb.auth.getSession();
      if (!data.session) { setFailed(true); return; }
      try { await api.me(); router.replace(next ?? '/home'); } catch (e) {
        router.replace(isApiError(e) && e.code === 'NOT_REGISTERED' ? withNext('/onboarding', next) : next ?? '/home');
      }
    })();
  }, [router]);
  if (failed) return <EmptyState icon="user" title={t.auth.callbackFailed} action={<ButtonLink href="/login" variant="primary">{t.common.logIn}</ButtonLink>} />;
  return <p role="status" className="muted">{t.auth.callbackWorking}</p>;
}
