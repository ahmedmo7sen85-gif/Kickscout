'use client';

import Link from 'next/link';
import { useNow } from '@/components/football/Football';
import { useFootball } from '@/components/football/useFootball';
import { Section } from '@/components/PageHead';
import { SkeletonList } from '@/components/ui/Skeleton';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/football';
import { useI18n } from '@/lib/i18n/provider';
import type { NewsArticleView } from '@/lib/types';

const fullDate = (iso: string, locale: string) => new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * One headline. The publisher is named on the card and the headline links to the original article
 * (nothing is republished here). The publication time is the publisher's; the import time is shown
 * separately, in the tooltip, so the two are never confused.
 */
export function NewsCard({ a, compact = false }: { a: NewsArticleView; compact?: boolean }) {
  const { t, fmt, locale } = useI18n();
  const now = useNow(60_000);
  const publisher = a.source.section && !compact ? `${a.source.publisher} · ${a.source.section}` : a.source.publisher;
  return (
    <li className={`news-card${compact ? ' news-card--compact' : ''}`} data-testid="news-card">
      <p className="news-card__meta small">
        <span className="news-card__publisher">{publisher}</span>
        <span aria-hidden="true"> · </span>
        <time dateTime={a.publishedAt} title={`${fullDate(a.publishedAt, locale)} · ${fmt(t.news.imported, { time: relativeTime(a.importedAt, now, locale) })}`}>
          {fmt(t.news.published, { time: relativeTime(a.publishedAt, now, locale) })}
        </time>
        {a.rumour ? <> <span className="badge badge--warn" title={t.news.rumourNote}>{t.news.rumour}</span></> : null}
      </p>
      <h3 className="news-card__title" lang={a.language} dir="auto">
        <a href={a.url} target="_blank" rel="noopener" className="news-card__link">
          {a.title}<span className="sr-only"> {t.news.opensNew}</span>
        </a>
      </h3>
      {!compact && a.summary ? <p className="news-card__summary" lang={a.language} dir="auto">{a.summary}</p> : null}
      {!compact ? (
        <p className="news-card__foot small muted">
          {a.topics.filter((x) => x !== 'general').map((x) => <span key={x} className="badge badge--neutral">{t.news.topic[x]}</span>)}
          <a href={a.url} target="_blank" rel="noopener" className="link news-card__source">{fmt(t.news.readAt, { publisher: a.source.publisher })}</a>
        </p>
      ) : null}
    </li>
  );
}

/** The newest headlines in a short list (scores and team pages); hidden when news cannot load. */
export function LatestNews({ q, title, emptyText, limit = 5 }: { q?: string; title?: string; emptyText?: string; limit?: number }) {
  const { t } = useI18n();
  const r = useFootball((s) => api.news({ q, limit, rumours: 'exclude' }, s), [q, limit], { refreshMs: 5 * 60_000 });
  if (r.error && !r.data) return null;
  return (
    <Section title={title ?? t.news.latest} id="latest-news" action={<Link href="/news" className="link small">{t.news.seeAll}</Link>}>
      {r.loading && !r.data ? <SkeletonList rows={3} label={t.news.loading} />
        : r.data?.items.length ? <ul className="news-list news-list--compact">{r.data.items.map((a) => <NewsCard key={a.id} a={a} compact />)}</ul>
        : <p className="muted small">{emptyText ?? t.news.emptyText}</p>}
    </Section>
  );
}
