'use client';

import type { ReactNode } from 'react';
import { PageHead } from '@/components/PageHead';
import { ButtonLink } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/Skeleton';
import { AuthNotConfigured } from '@/components/ui/States';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';

/**
 * Shows scout tools to users whose roles include `scout`, and explains how to apply to everyone
 * else. This is only a convenience: the API refuses scout endpoints to non-scouts regardless.
 */
export function ScoutGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { status, me, isScout } = useAuth();
  if (status === 'loading' || (status === 'signed_in' && !me)) {
    return <div className="wrap page"><SkeletonList rows={4} label={t.common.loading} /></div>;
  }
  if (isScout) return <>{children}</>;
  const app = me?.scoutApplication ?? 'none';
  return (
    <div className="wrap wrap--mid page" data-testid="scout-gate">
      <PageHead title={t.scout.title} intro={t.scout.intro} />
      {status === 'unconfigured' ? <AuthNotConfigured /> : null}
      <section className="card">
        <h2 className="section-title">{app === 'pending' ? t.scout.pendingTitle : t.scout.notScoutTitle}</h2>
        <p className="muted">{app === 'pending' ? t.scout.pendingText : t.scout.notScoutText}</p>
        {app === 'rejected' ? <p className="notice notice--warn small">{t.scout.rejectedText}</p> : null}
        {app !== 'pending' ? (
          <ol className="ticks">
            <li>{t.scout.applyStep1}</li>
            <li>{t.scout.applyStep2}</li>
            <li>{t.scout.applyStep3}</li>
          </ol>
        ) : null}
        <div className="cta-row">
          {status === 'signed_in'
            ? (app !== 'pending' ? <ButtonLink href="/settings#verification" variant="primary">{t.scout.applyCta}</ButtonLink> : null)
            : <><ButtonLink href="/signup" variant="primary">{t.common.signUp}</ButtonLink><ButtonLink href="/login">{t.common.logIn}</ButtonLink></>}
          <ButtonLink href="/for-scouts" variant="ghost">{t.nav.forScouts}</ButtonLink>
        </div>
      </section>
    </div>
  );
}
