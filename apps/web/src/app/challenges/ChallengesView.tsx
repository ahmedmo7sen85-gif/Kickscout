'use client';

import { PageHead, Section } from '@/components/PageHead';
import { ButtonLink } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';
import type { ChallengeView } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { ChallengeTile } from '../discover/DiscoverView';

/** The challenge hub: featured, picked for you, trending, new, ending soon, by level, upcoming and finished. */
export function ChallengesView() {
  const { t } = useI18n();
  const { status } = useAuth();
  const hub = useApi((s) => api.challengeHub(s), []);
  const rec = useApi((s) => api.recommendedChallenges(s), [status], { enabled: status === 'signed_in' });

  const sections: { id: string; title: string; items: ChallengeView[] }[] = hub.status === 'success' ? [
    { id: 'trending', title: t.challenges.hubTrending, items: hub.data.trending },
    { id: 'ending', title: t.challenges.hubEndingSoon, items: hub.data.endingSoon },
    { id: 'new', title: t.challenges.hubNewest, items: hub.data.newest },
    { id: 'beginner', title: t.challenges.hubBeginner, items: hub.data.beginner },
    { id: 'advanced', title: t.challenges.hubAdvanced, items: hub.data.advancedFreestyle },
    { id: 'upcoming', title: t.challenges.hubUpcoming, items: hub.data.upcoming },
    { id: 'completed', title: t.challenges.hubCompleted, items: hub.data.completed },
  ].filter((s) => s.items.length) : [];
  const empty = hub.status === 'success' && !hub.data.featured && sections.length === 0;

  return (
    <div className="wrap page">
      <PageHead title={t.challenges.title} intro={t.challenges.intro}
        actions={status === 'signed_in' ? <ButtonLink href="/challenges/mine">{t.challenges.myChallenges}</ButtonLink> : undefined} />
      <p className="small muted">{t.challenges.noCash}</p>
      {hub.status === 'loading' ? <SkeletonList rows={4} label={t.common.loading} /> : null}
      {hub.status === 'error' ? <ErrorState error={hub.error} title={t.challenges.errorTitle} onRetry={hub.retry} /> : null}
      {empty ? <EmptyState icon="trophy" title={t.states.emptyTitle} text={t.challenges.empty} /> : null}
      {hub.status === 'success' && hub.data.featured ? (
        <Section title={t.challenges.hubFeatured} id="ch-featured">
          <div className="grid-players"><ChallengeTile c={hub.data.featured} /></div>
        </Section>
      ) : null}
      {rec.status === 'success' && rec.data.items.length ? (
        <Section title={t.challenges.hubForYou} id="ch-for-you">
          <div className="grid-players">{rec.data.items.map((r) => <ChallengeTile key={r.challenge.id} c={r.challenge} reasons={r.reasons} />)}</div>
        </Section>
      ) : null}
      {sections.map((g) => (
        <Section key={g.id} title={g.title} id={`ch-${g.id}`}>
          <div className="grid-players">{g.items.map((x) => <ChallengeTile key={x.id} c={x} />)}</div>
        </Section>
      ))}
    </div>
  );
}
