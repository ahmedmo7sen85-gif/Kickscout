'use client';

import type { ReactNode } from 'react';
import { SkeletonList } from '@/components/ui/Skeleton';
import { AuthNotConfigured, AuthRequired } from '@/components/ui/States';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';

/** Renders children once a session and profile exist; otherwise a friendly log-in prompt. */
export function AuthGate({ children, requireProfile = true }: { children: ReactNode; requireProfile?: boolean }) {
  const { t } = useI18n();
  const { status, me, meError } = useAuth();
  if (status === 'unconfigured') return <AuthNotConfigured />;
  if (status === 'signed_out') return <AuthRequired />;
  if (status === 'loading' || (requireProfile && !me && !meError)) return <SkeletonList rows={4} label={t.common.loading} />;
  return <>{children}</>;
}
