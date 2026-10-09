'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { PageHead } from '@/components/PageHead';
import { Button, ButtonLink } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { withNext } from '@/lib/next-path';

export function GuardianAccept() {
  const { t } = useI18n();
  const token = useSearchParams().get('token') ?? '';
  const { needsOnboarding } = useAuth();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const accept = async () => {
    setState('busy'); setError(null);
    try { await api.acceptGuardian({ token }); setState('done'); } catch (e) { setError(errorMessage(e, t)); setState('idle'); }
  };
  return (
    <>
      <PageHead title={t.guardian.title} intro={t.guardian.intro} />
      <AuthGate requireProfile={false}>
        <div className="card">
          {token.length < 32 ? <p className="field__error">{t.guardian.missingToken}</p> : state === 'done' ? (
            <><p>{t.guardian.accepted}</p><div><ButtonLink href="/settings" variant="primary">{t.nav.settings}</ButtonLink></div></>
          ) : needsOnboarding ? (
            // A guardian needs their own (adult) profile first; onboarding brings them back here.
            <><p>{t.errors.NOT_REGISTERED}</p><div><ButtonLink href={withNext('/onboarding', `/guardian/accept?token=${encodeURIComponent(token)}`)} variant="primary">{t.onboarding.title}</ButtonLink></div></>
          ) : (
            <>
              {error ? <p className="field__error" role="alert">{error}</p> : null}
              <div><Button variant="primary" loading={state === 'busy'} onClick={accept}>{t.guardian.accept}</Button></div>
            </>
          )}
        </div>
      </AuthGate>
    </>
  );
}
