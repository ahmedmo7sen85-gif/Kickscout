'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { PageHead } from '@/components/PageHead';
import { Button, ButtonLink } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';

/** Target of the emailed invitation link: /org/invite?token=… */
export function OrgInviteAccept() {
  const { t } = useI18n();
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'idle' | 'busy' | 'accepted' | 'declined'>('idle');
  const [orgId, setOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (accept: boolean) => {
    setState('busy'); setError(null);
    try {
      if (accept) { const r = await api.acceptOrgInvitation({ token }); setOrgId(r.organizationId); setState('accepted'); }
      else { await api.declineOrgInvitation({ token }); setState('declined'); }
    } catch (e) { setError(errorMessage(e, t)); setState('idle'); }
  };
  return (
    <>
      <PageHead title={t.org.acceptTitle} intro={t.org.acceptIntro} />
      <AuthGate>
        <div className="card">
          {token.length < 32 ? <p className="field__error">{t.org.missingToken}</p>
            : state === 'accepted' ? <><p>{t.org.accepted}</p>{orgId ? <div><ButtonLink href={`/org/${orgId}`} variant="primary">{t.org.dashboard}</ButtonLink></div> : null}</>
            : state === 'declined' ? <p>{t.org.declined}</p>
            : (
              <>
                {error ? <p className="field__error" role="alert">{error}</p> : null}
                <div className="row">
                  <Button variant="primary" loading={state === 'busy'} onClick={() => act(true)}>{t.org.accept}</Button>
                  <Button variant="ghost" disabled={state === 'busy'} onClick={() => act(false)}>{t.org.decline}</Button>
                </div>
              </>
            )}
        </div>
      </AuthGate>
    </>
  );
}
