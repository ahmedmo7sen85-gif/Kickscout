'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useRef, useState } from 'react';
import { CapabilityBadge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { Tabs } from '@/components/ui/Tabs';
import { FeedPlayer } from '@/components/video/FeedPlayer';
import { api } from '@/lib/api';
import { FEED_TABS } from '@/lib/constants';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { FeedTab, VideoView } from '@/lib/types';

export function FeedView() {
  return <Suspense fallback={<FeedSkeleton />}><FeedInner /></Suspense>;
}

function FeedSkeleton() {
  const { t } = useI18n();
  return (
    <div className="feed-page__state" role="status" aria-label={t.common.loading}>
      <div className="stack" style={{ inlineSize: 'min(22rem, 100%)' }}>
        <Skeleton height="min(60dvh, 34rem)" radius="1rem" />
        <Skeleton width="40%" />
        <Skeleton width="70%" height="0.8rem" />
      </div>
    </div>
  );
}

function FeedInner() {
  const { t } = useI18n();
  const params = useSearchParams();
  const raw = params.get('tab');
  const tab: FeedTab = (FEED_TABS as readonly string[]).includes(raw ?? '') ? (raw as FeedTab) : 'for_you';
  const labels: Record<FeedTab, string> = { for_you: t.feed.forYou, following: t.feed.following, new_talent: t.feed.newTalent, trending: t.feed.trending };

  const page = useApi((s) => api.feed({ tab }, s), [tab]);
  const [more, setMore] = useState<{ tab: FeedTab; items: VideoView[]; cursor: string | null } | null>(null);
  const loading = useRef(false);

  const items = page.status === 'success' ? [...page.data.items, ...(more?.tab === tab ? more.items : [])] : [];
  const cursor = page.status === 'success' ? (more?.tab === tab ? more.cursor : page.data.nextCursor) : null;

  const loadMore = useCallback(() => {
    if (!cursor || loading.current) return;
    loading.current = true;
    api.feed({ tab, cursor }).then(
      (p) => setMore((m) => ({ tab, items: [...(m?.tab === tab ? m.items : []), ...p.items], cursor: p.nextCursor })),
      () => {},
    ).finally(() => { loading.current = false; });
  }, [cursor, tab]);

  return (
    <div className="feed-page">
      <h1 className="sr-only">{t.feed.title}</h1>
      <div className="feed-page__tabs">
        <Tabs
          label={t.feed.tabsLabel}
          active={tab}
          panelId="feed-panel"
          items={FEED_TABS.map((k) => ({ id: k, label: labels[k], href: k === 'for_you' ? '/home' : `/home?tab=${k}` }))}
          onChange={() => setMore(null)}
        />
      </div>
      <div id="feed-panel" role="tabpanel" aria-label={labels[tab]}>
        {page.status === 'loading' ? <FeedSkeleton /> : null}
        {page.status === 'error' ? (
          <div className="feed-page__state"><ErrorState error={page.error} title={t.feed.errorTitle} onRetry={page.retry} /></div>
        ) : null}
        {page.status === 'success' && page.data.capability.status !== 'live' ? (
          <div className="feed-page__state">
            <EmptyState title={labels[tab]} text={t.feed.emptyText} action={<CapabilityBadge capability={page.data.capability} />} />
          </div>
        ) : null}
        {page.status === 'success' && page.data.capability.status === 'live' && items.length === 0 ? (
          <div className="feed-page__state">
            <EmptyState icon="play" title={t.feed.emptyTitle} text={tab === 'following' ? t.feed.emptyFollowingText : t.feed.emptyText}
              action={<ButtonLink href="/upload" variant="primary">{t.feed.emptyCta}</ButtonLink>} />
          </div>
        ) : null}
        {page.status === 'success' && page.data.capability.status === 'live' && items.length > 0 ? (
          <FeedPlayer videos={items} onNearEnd={loadMore} hideFollow={tab === 'following'} />
        ) : null}
      </div>
    </div>
  );
}
