'use client';

import { useEffect } from 'react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { useI18n } from '@/lib/i18n/provider';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="wrap page notfound" role="alert">
      <div className="stack" style={{ justifyItems: 'center' }}>
        <h1 className="display">{t.pages.errorTitle}</h1>
        <p className="lede">{t.pages.errorText}</p>
        <div className="cta-row"><Button variant="primary" onClick={reset}>{t.common.retry}</Button><ButtonLink href="/">{t.pages.goHome}</ButtonLink></div>
        {error.digest ? <p className="state__trace">ref {error.digest}</p> : null}
      </div>
    </div>
  );
}
