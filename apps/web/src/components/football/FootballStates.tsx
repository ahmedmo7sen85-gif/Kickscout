'use client';

import { EmptyState, ErrorState } from '@/components/ui/States';
import { Button } from '@/components/ui/Button';
import type { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/provider';

/** Football-specific wording for the errors a provider-backed page can hit; others use the shared error state. */
export function FootballError({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const { t } = useI18n();
  if (error.code === 'FOOTBALL_DISABLED') return <EmptyState icon="ball" title={t.football.disabledTitle} text={t.football.disabledText} />;
  if (error.code === 'FOOTBALL_PROVIDER_UNAVAILABLE') {
    return (
      <div role="alert">
        <EmptyState icon="ball" title={t.football.unavailableTitle} text={t.football.unavailableText}
          action={onRetry ? <Button onClick={onRetry}>{t.common.retry}</Button> : undefined} />
      </div>
    );
  }
  if (error.code === 'NOT_SUPPORTED_BY_PROVIDER') return <EmptyState icon="ball" title={t.errors.NOT_SUPPORTED_BY_PROVIDER} />;
  return <ErrorState error={error} onRetry={onRetry} />;
}

export function OfflineNotice() {
  const { t } = useI18n();
  return <p className="notice notice--warn" role="status">{t.football.offline}</p>;
}
