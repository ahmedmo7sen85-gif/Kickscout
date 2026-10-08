'use client';

import { useState } from 'react';
import { PageHead, Section } from '@/components/PageHead';
import { DemoBadge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { Skeleton, SkeletonGrid, SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { SkillChip } from '@/components/video/SkillChip';
import { VideoCard } from '@/components/video/VideoCard';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';

export function ChallengeDetail({ slug }: { slug: string }) {
  const { t, fmt, pick, formatDate, formatNumber } = useI18n();
  const { status } = useAuth();
  const toast = useToast();
  const c = useApi((s) => api.challenge(slug, s), [slug]);
  const entries = useApi((s) => api.challengeEntries(slug, undefined, s), [slug]);
  const [open, setOpen] = useState(false);
  const mine = useApi((s) => api.myVideos(undefined, s), [], { enabled: open && status === 'signed_in' });
  const [entering, setEntering] = useState<string | null>(null);

  if (c.status === 'loading') return <div className="wrap page" role="status" aria-label={t.common.loading}><Skeleton width="60%" height="3rem" /><SkeletonList rows={2} label={t.common.loading} /></div>;
  if (c.status === 'error') {
    return (
      <div className="wrap page">
        {c.error.status === 404 ? <EmptyState icon="trophy" title={t.challenges.notFound} action={<ButtonLink href="/challenges">{t.challenges.title}</ButtonLink>} />
          : <ErrorState error={c.error} title={t.challenges.errorTitle} onRetry={c.retry} />}
      </div>
    );
  }
  const ch = c.data;
  const stateLabel = ch.state === 'active' ? t.challenges.active : ch.state === 'upcoming' ? t.challenges.upcoming : t.challenges.ended;

  const enter = async (videoId: string) => {
    setEntering(videoId);
    try {
      await api.enterChallenge(slug, { videoId });
      toast.show(t.challenges.entered, { tone: 'success' });
      setOpen(false);
      entries.retry();
      c.retry();
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setEntering(null);
    }
  };

  return (
    <div className="wrap page">
      <PageHead
        kicker={<span className="row"><span className={`badge ${ch.state === 'active' ? 'badge--green' : 'badge--outline'}`}>{stateLabel}</span>{ch.isDemo ? <DemoBadge /> : null}</span>}
        title={pick(ch.title)}
        intro={pick(ch.description)}
      />
      <div className="row">
        {ch.hashtag ? <span className="chip chip--hashtag" dir="auto">#{ch.hashtag}</span> : null}
        {ch.skill ? <SkillChip skill={ch.skill} /> : null}
        <span className="muted small">{fmt(t.challenges.dates, { start: formatDate(ch.startsAt), end: formatDate(ch.endsAt) })} · {fmt(t.challenges.entries, { n: formatNumber(ch.entries) })}</span>
      </div>
      {ch.state === 'active' ? (
        <div className="cta-row">
          <Button variant="primary" onClick={() => setOpen(true)}>{t.challenges.enter}</Button>
          <ButtonLink href={`/upload?challenge=${encodeURIComponent(ch.id)}&slug=${encodeURIComponent(ch.slug)}`}>{t.challenges.uploadForChallenge}</ButtonLink>
        </div>
      ) : null}

      <Section title={t.challenges.entriesTitle} id="entries">
        {entries.status === 'loading' ? <SkeletonGrid count={4} label={t.common.loading} /> : null}
        {entries.status === 'error' ? <ErrorState error={entries.error} onRetry={entries.retry} /> : null}
        {entries.status === 'success' && entries.data.items.length === 0 ? <EmptyState icon="trophy" title={t.challenges.entriesEmpty} /> : null}
        {entries.status === 'success' && entries.data.items.length > 0 ? (
          <div className="grid-cards">{entries.data.items.map((v) => <VideoCard key={v.id} video={v} />)}</div>
        ) : null}
      </Section>

      <Sheet open={open} onClose={() => setOpen(false)} title={t.challenges.enterTitle} size="lg"
        footer={<ButtonLink href={`/upload?challenge=${encodeURIComponent(ch.id)}&slug=${encodeURIComponent(ch.slug)}`} variant="secondary" block>{t.challenges.uploadForChallenge}</ButtonLink>}>
        {status !== 'signed_in' ? <p className="muted">{t.feed.loginToAct}</p> : null}
        {status === 'signed_in' && mine.status === 'loading' ? <SkeletonList rows={3} label={t.common.loading} /> : null}
        {status === 'signed_in' && mine.status === 'error' ? <ErrorState error={mine.error} onRetry={mine.retry} /> : null}
        {status === 'signed_in' && mine.status === 'success' ? (() => {
          const published = mine.data.items.filter((v) => v.status === 'published');
          if (!published.length) return <EmptyState icon="play" title={t.challenges.noVideos} />;
          return (
            <>
              <p className="muted small">{t.challenges.pickVideo}</p>
              <ul className="list">
                {published.map((v) => (
                  <li key={v.id} className="list__row">
                    <span dir="auto">{v.title}</span>
                    <Button size="sm" variant="primary" loading={entering === v.id} disabled={entering !== null} onClick={() => enter(v.id)}>{t.common.submit}</Button>
                  </li>
                ))}
              </ul>
            </>
          );
        })() : null}
      </Sheet>
    </div>
  );
}
