'use client';

import { STATUS_LABELS } from '@fp/domain';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import type { Capability, CapabilityStatus } from '@/lib/types';
import { Icon } from './Icon';

type Tone = 'neutral' | 'green' | 'outline' | 'warn' | 'danger';

export function Badge({ tone = 'neutral', children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return <span className={['badge', `badge--${tone}`, className ?? ''].filter(Boolean).join(' ')} title={title}>{children}</span>;
}

/** Shown only when the API says `verified: true`. */
export function VerifiedBadge({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <span className="badge badge--verified" title={t.common.verified}>
      <Icon name="check" size={12} />
      {compact ? <span className="sr-only">{t.common.verified}</span> : t.common.verified}
    </span>
  );
}

export function AiBadge({ label }: { label?: string }) {
  const { t } = useI18n();
  return <span className="badge badge--ai">{label ?? t.common.aiGenerated}</span>;
}

export function DemoBadge() {
  const { t } = useI18n();
  return <span className="badge badge--demo" title={t.common.demoAccount}>{t.common.demo}</span>;
}

/** Status label for a capability that is not live (Coming Soon, Prototype, Requires Model Integration). */
export function CapabilityBadge({ status, capability }: { status?: CapabilityStatus; capability?: Capability }) {
  const { pick } = useI18n();
  const s = capability?.status ?? status ?? 'coming_soon';
  if (s === 'live') return null;
  const text = pick(capability?.label ?? STATUS_LABELS[s]);
  return <span className="badge badge--soon">{text}</span>;
}

export function ComingSoonBadge() {
  return <CapabilityBadge status="coming_soon" />;
}
