'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import type { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/provider';
import { errorMessage } from '@/lib/errors';
import { withNext } from '@/lib/next-path';
import { Button, ButtonLink } from './Button';
import { Icon, type IconName } from './Icon';

export function EmptyState({ title, text, icon = 'spark', action }: { title: string; text?: string; icon?: IconName; action?: ReactNode }) {
  return (
    <div className="state state--empty">
      <span className="state__icon"><Icon name={icon} size={28} /></span>
      <h2 className="state__title">{title}</h2>
      {text ? <p className="state__text">{text}</p> : null}
      {action ? <div className="state__action">{action}</div> : null}
    </div>
  );
}

/** Friendly error with a retry. 401 offers log-in, 403 explains, network errors say so. */
export function ErrorState({ error, title, onRetry }: { error: ApiError; title?: string; onRetry?: () => void }) {
  const { t } = useI18n();
  const network = error.isNetwork;
  const heading = network ? t.errors.networkTitle : title ?? t.errors.genericTitle;
  const text = network ? t.errors.networkText : errorMessage(error, t);
  return (
    <div className="state state--error" role="alert" data-testid="error-state">
      <span className="state__icon"><Icon name={network ? 'globe' : 'flag'} size={28} /></span>
      <h2 className="state__title">{heading}</h2>
      <p className="state__text">{text}</p>
      <div className="state__action">
        {error.isAuth ? <ButtonLink href="/login" variant="primary">{t.common.logIn}</ButtonLink> : null}
        {error.code === 'NOT_REGISTERED' ? <ButtonLink href="/onboarding" variant="primary">{t.onboarding.continue}</ButtonLink> : null}
        {error.code === 'SCOUT_VERIFICATION_REQUIRED' || error.code === 'CONSENT_REQUIRED'
          ? <ButtonLink href="/settings" variant="secondary">{t.nav.settings}</ButtonLink> : null}
        {onRetry && !error.isAuth ? <Button onClick={onRetry}>{t.common.retry}</Button> : null}
      </div>
      {error.traceId ? <p className="state__trace">ref {error.traceId}</p> : null}
    </div>
  );
}

export function AuthRequired({ text }: { text?: string }) {
  const { t } = useI18n();
  // Come back to this page (e.g. a guardian invitation link) after logging in or signing up.
  const [here, setHere] = useState<string | null>(null);
  useEffect(() => { setHere(window.location.pathname + window.location.search); }, []);
  return (
    <div className="state">
      <span className="state__icon"><Icon name="user" size={28} /></span>
      <h2 className="state__title">{t.common.authRequiredTitle}</h2>
      <p className="state__text">{text ?? t.common.authRequiredText}</p>
      <div className="state__action">
        <ButtonLink href={withNext('/login', here)} variant="primary">{t.common.logIn}</ButtonLink>
        <ButtonLink href={withNext('/signup', here)}>{t.common.signUp}</ButtonLink>
      </div>
    </div>
  );
}

export function AuthNotConfigured() {
  const { t } = useI18n();
  return (
    <div className="notice notice--warn" role="status" data-testid="auth-not-configured">
      <strong>{t.auth.notConfiguredTitle}</strong>
      <p>{t.auth.notConfiguredText}</p>
      <Link href="/" className="link">{t.pages.goHome}</Link>
    </div>
  );
}
