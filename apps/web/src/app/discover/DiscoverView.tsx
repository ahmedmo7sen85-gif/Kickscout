'use client';

import Link from 'next/link';
import { PageHead, Section } from '@/components/PageHead';
import { PlayerCard } from '@/components/player/PlayerCard';
import { DemoBadge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Skeleton, SkeletonGrid } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { HashtagChip, SkillChip } from '@/components/video/SkillChip';
import { VideoCard } from '@/components/video/VideoCard';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { ChallengeView } from '@/lib/types';

export function DiscoverView() {
  const { t } = useI18n();
  const d = useApi((s) => api.discover(s), []);

  return (
    <div className="wrap page">
      <PageHead title={t.discover.title} intro={t.discover.intro} actions={<ButtonLink href="/search" size="sm">{t.discover.searchCta}</ButtonLink>} />
      {d.status === 'loading' ? (
        <div className="stack stack--loose" role="status" aria-label={t.common.loading}>
          <div className="row">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} width="6.5rem" height="2.2rem" radius="999px" />)}</div>
          <SkeletonGrid count={6} label={t.common.loading} />
        </div>
      ) : null}
      {d.status === 'error' ? <ErrorState error={d.error} title={t.discover.errorTitle} onRetry={d.retry} /> : null}
      {d.status === 'success' ? (() => {
        const v = d.data;
        const empty = !v.skills.length && !v.trendingHashtags.length && !v.challenges.length && !v.risingPlayers.length && !v.latest.length;
        if (empty) return <EmptyState title={t.states.emptyTitle} text={t.discover.empty} action={<ButtonLink href="/upload" variant="primary">{t.feed.emptyCta}</ButtonLink>} />;
        return (
          <>
            {v.skills.length ? (
              <Section title={t.discover.skills} id="d-skills">
                <ul className="chips">{v.skills.map((s) => <li key={s.key}><SkillChip skill={s.key} count={s.videos} href={`/search?skill=${s.key}&type=videos`} /></li>)}</ul>
              </Section>
            ) : null}
            {v.trendingHashtags.length ? (
              <Section title={t.discover.trendingHashtags} id="d-tags">
                <ul className="chips">{v.trendingHashtags.map((h) => <li key={h.tag}><HashtagChip tag={h.tag} count={h.videos} href={`/search?hashtag=${encodeURIComponent(h.tag)}&type=videos`} /></li>)}</ul>
              </Section>
            ) : null}
            {v.challenges.length ? (
              <Section title={t.discover.challenges} id="d-ch" action={<Link href="/challenges" className="link small">{t.common.seeAll}</Link>}>
                <div className="grid-players">{v.challenges.map((c) => <ChallengeTile key={c.id} c={c} />)}</div>
              </Section>
            ) : null}
            {v.risingPlayers.length ? (
              <Section title={t.discover.risingPlayers} id="d-players" action={<Link href="/radar" className="link small">{t.nav.radar}</Link>}>
                <div className="grid-players">{v.risingPlayers.map((p) => <PlayerCard key={p.userId} player={p} />)}</div>
              </Section>
            ) : null}
            {v.latest.length ? (
              <Section title={t.discover.latest} id="d-latest">
                <div className="grid-cards">{v.latest.map((x) => <VideoCard key={x.id} video={x} />)}</div>
              </Section>
            ) : null}
          </>
        );
      })() : null}
    </div>
  );
}

export function ChallengeTile({ c }: { c: ChallengeView }) {
  const { t, fmt, pick, formatDate, formatNumber } = useI18n();
  const stateLabel = c.state === 'active' ? t.challenges.active : c.state === 'upcoming' ? t.challenges.upcoming : t.challenges.ended;
  return (
    <Link href={`/challenges/${c.slug}`} className="card card--outline" style={{ textDecoration: 'none' }}>
      <div className="row">
        <span className={`badge ${c.state === 'active' ? 'badge--green' : 'badge--outline'}`}>{stateLabel}</span>
        {c.isDemo ? <DemoBadge /> : null}
      </div>
      <h3 className="section-title" style={{ fontSize: '1.35rem' }}>{pick(c.title)}</h3>
      {c.hashtag ? <p className="small" dir="auto">#{c.hashtag}</p> : null}
      <p className="small muted">{fmt(t.challenges.dates, { start: formatDate(c.startsAt), end: formatDate(c.endsAt) })} · {fmt(t.challenges.entries, { n: formatNumber(c.entries) })}</p>
    </Link>
  );
}
