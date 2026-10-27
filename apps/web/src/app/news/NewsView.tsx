'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useNow } from '@/components/football/Football';
import { OfflineNotice } from '@/components/football/FootballStates';
import { NewsCard } from '@/components/football/News';
import { useFootball } from '@/components/football/useFootball';
import { PageHead } from '@/components/PageHead';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { Tabs } from '@/components/ui/Tabs';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/football';
import { useI18n } from '@/lib/i18n/provider';
import type { NewsArticleView, NewsRegion, NewsTopic } from '@/lib/types';

type RegionTab = 'all' | NewsRegion;
const REGIONS: RegionTab[] = ['all', 'africa', 'europe', 'asia', 'north-america', 'south-america', 'oceania'];
const TOPICS: ('all' | NewsTopic)[] = ['all', 'transfers', 'injuries', 'match-report', 'managers', 'national-teams', 'talent'];
const LANGUAGES = ['all', 'en', 'ar'] as const;
type Language = (typeof LANGUAGES)[number];

const pick = <T extends string>(v: string | null, all: readonly T[], fallback: T): T => ((all as readonly string[]).includes(v ?? '') ? (v as T) : fallback);

export function NewsView() {
  const { t, fmt, locale } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const now = useNow(60_000);

  const region = pick(params.get('region'), REGIONS, 'all');
  const topic = pick(params.get('topic'), TOPICS, 'all');
  const language = pick(params.get('language'), LANGUAGES, 'all');
  const hideRumours = params.get('rumours') === 'exclude';

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) if (v) next.set(k, v); else next.delete(k);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const filters = {
    region: region === 'all' ? undefined : region,
    topic: topic === 'all' ? undefined : topic,
    language: language === 'all' ? undefined : language,
    rumours: hideRumours ? ('exclude' as const) : ('include' as const),
  };
  const key = JSON.stringify(filters);
  const q = useFootball((s) => api.news({ ...filters, limit: 20 }, s), [key], { refreshMs: 5 * 60_000 });

  // Older pages, appended by "Load more"; reset whenever the filters or the first page change.
  const [more, setMore] = useState<NewsArticleView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { setMore([]); setCursor(q.data?.nextCursor ?? null); }, [q.data]);
  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api.news({ ...filters, limit: 20, cursor });
      setMore((m) => [...m, ...page.items.filter((a) => !m.some((x) => x.id === a.id))]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };
  const items = [...(q.data?.items ?? []), ...more];
  const failing = q.data?.failingSources ?? [];

  return (
    <div className="wrap wrap--mid page">
      <PageHead title={t.news.title} intro={t.news.intro}
        actions={<Button variant="secondary" size="sm" onClick={q.refresh} disabled={q.loading}>{t.news.refresh}</Button>} />

      {!q.online ? <OfflineNotice /> : null}

      <Tabs<RegionTab> label={t.news.regionLabel} active={region} onChange={(r) => setParam({ region: r === 'all' ? null : r })}
        items={REGIONS.map((r) => ({ id: r, label: t.news.region[r] }))} />

      <div className="news-toolbar">
        <label className="small">
          <span className="muted">{t.news.topicLabel}</span>{' '}
          <select className="input input--sm" value={topic} onChange={(e) => setParam({ topic: e.target.value === 'all' ? null : e.target.value })}>
            {TOPICS.map((x) => <option key={x} value={x}>{t.news.topic[x]}</option>)}
          </select>
        </label>
        <label className="small">
          <span className="muted">{t.news.languageLabel}</span>{' '}
          <select className="input input--sm" value={language} onChange={(e) => setParam({ language: e.target.value === 'all' ? null : e.target.value })}>
            <option value="all">{t.news.allLanguages}</option>
            <option value="en" lang="en">{t.news.english}</option>
            <option value="ar" lang="ar">{t.news.arabic}</option>
          </select>
        </label>
        <label className="small row">
          <input type="checkbox" checked={hideRumours} onChange={(e) => setParam({ rumours: e.target.checked ? 'exclude' : null })} />
          <span>{t.news.hideRumours}</span>
        </label>
      </div>

      {q.data ? (
        <p className="small muted" aria-live="polite" data-testid="news-updated">
          {q.data.updatedAt ? fmt(t.news.updated, { time: relativeTime(q.data.updatedAt, now, locale) }) : t.news.notUpdated}
          {' · '}{fmt(t.news.refreshNote, { n: Math.round(q.data.refreshEverySeconds / 60) })}
        </p>
      ) : null}
      {failing.length ? <p className="notice notice--warn small" role="status">{fmt(t.news.failing, { sources: failing.map((f) => f.name).join(', ') })}</p> : null}
      {q.error && q.data ? <p className="notice notice--warn small" role="status">{t.football.unavailableText}</p> : null}

      {q.loading && !q.data ? <SkeletonList rows={6} label={t.news.loading} />
        : q.error && !q.data ? <ErrorState error={q.error} onRetry={q.retry} />
        : items.length ? (
          <>
            <ul className="news-list">{items.map((a) => <NewsCard key={a.id} a={a} />)}</ul>
            {cursor ? <div className="row"><Button variant="secondary" onClick={loadMore} disabled={loadingMore}>{t.news.loadMore}</Button></div> : null}
          </>
        ) : (
          <EmptyState icon="ball" title={t.news.emptyTitle}
            text={region === 'all' && topic === 'all' && language === 'all' && !hideRumours ? t.news.emptyAll : t.news.emptyText} />
        )}

      <p className="small muted">{t.news.sourcesNote} {t.news.topicsAuto}</p>
    </div>
  );
}
