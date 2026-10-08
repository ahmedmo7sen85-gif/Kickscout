'use client';

import { PageHead, Section } from '@/components/PageHead';
import { SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import { ChallengeTile } from '../discover/DiscoverView';

export function ChallengesView() {
  const { t } = useI18n();
  const c = useApi((s) => api.challenges(s), []);
  const groups = c.status === 'success'
    ? (['active', 'upcoming', 'ended'] as const).map((st) => ({ st, items: c.data.items.filter((x) => x.state === st) })).filter((g) => g.items.length)
    : [];
  const label = { active: t.challenges.active, upcoming: t.challenges.upcoming, ended: t.challenges.ended };

  return (
    <div className="wrap page">
      <PageHead title={t.challenges.title} intro={t.challenges.intro} />
      {c.status === 'loading' ? <SkeletonList rows={4} label={t.common.loading} /> : null}
      {c.status === 'error' ? <ErrorState error={c.error} title={t.challenges.errorTitle} onRetry={c.retry} /> : null}
      {c.status === 'success' && c.data.items.length === 0 ? <EmptyState icon="trophy" title={t.states.emptyTitle} text={t.challenges.empty} /> : null}
      {groups.map((g) => (
        <Section key={g.st} title={label[g.st]} id={`ch-${g.st}`}>
          <div className="grid-players">{g.items.map((x) => <ChallengeTile key={x.id} c={x} />)}</div>
        </Section>
      ))}
    </div>
  );
}
