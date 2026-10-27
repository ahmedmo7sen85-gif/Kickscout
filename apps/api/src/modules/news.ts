import { timingSafeEqual } from 'node:crypto';
import { NewsCronReport, NewsListQuery, NewsListView, NewsSourcesView } from '@fp/contracts';
import type { NewsSource } from '@fp/football';
import { route } from '../platform/route.js';
import { ApiError } from '../platform/errors.js';
import { decodeCursor, encodeCursor } from '../platform/cursor.js';
import { NEWS_REFRESH_SECONDS, NEWS_RETENTION_DAYS, type NewsService } from '../platform/news.js';
import type { Deps } from '../deps.js';

/** A reader with nothing stored waits up to this long for the first feeds; later reads wait less. */
const FIRST_LOAD_BUDGET_MS = 7000;
const REFRESH_BUDGET_MS = 2500;

function newsOf(deps: Deps): NewsService {
  if (!deps.news) throw new ApiError(503, 'NEWS_DISABLED', 'football news is not configured on this server');
  return deps.news;
}

function bearerIs(header: string | undefined, secret: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

const sourceView = (s: NewsSource) => ({
  id: s.id, publisher: s.publisher, section: s.section, homepage: s.homepage, language: s.language, region: s.region, country: s.country,
});

export const newsRoutes = [
  route(
    { method: 'get', path: '/v1/news', summary: 'Football news from publisher feeds, newest publication first; every item links to the original article', tag: 'news', auth: 'none', query: NewsListQuery, response: NewsListView, rateLimit: { max: 120, timeWindow: '1 minute' } },
    async (ctx) => {
      const news = newsOf(ctx.deps);
      const q = ctx.query;
      if (q.source && !news.source(q.source)) throw new ApiError(400, 'UNKNOWN_SOURCE', 'unknown news source');
      // Feeds are read lazily by whoever asks first once they are due, inside a time budget.
      if (await news.needsRefresh()) {
        const empty = (await news.lastUpdate()) === null;
        await news.refreshWithin(empty ? FIRST_LOAD_BUDGET_MS : REFRESH_BUDGET_MS);
      }
      const rows = await news.list({
        region: q.region, language: q.language, topic: q.topic, source: q.source, q: q.q, rumours: q.rumours === 'include',
        before: q.cursor ? decodeCursor(q.cursor) : undefined, limit: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      const status = await news.status();
      const updatedAt = await news.lastUpdate();
      return {
        items: page.map((r) => ({
          id: r.id, title: r.title, summary: r.summary, url: r.url, imageUrl: r.image_url,
          source: sourceView(news.source(r.source_id)!),
          language: r.language as 'en' | 'ar', region: r.region as NewsSource['region'], country: r.country,
          topics: r.topics as never, rumour: r.rumour,
          publishedAt: new Date(r.published_at).toISOString(), importedAt: new Date(r.imported_at).toISOString(),
        })),
        nextCursor: rows.length > q.limit && last ? encodeCursor(new Date(last.published_at), last.id) : null,
        updatedAt: updatedAt?.toISOString() ?? null,
        failingSources: status.filter((s) => s.enabled && s.failures > 0)
          .map((s) => ({ id: s.source.id, name: s.source.section ? `${s.source.publisher} (${s.source.section})` : s.source.publisher })),
        refreshEverySeconds: NEWS_REFRESH_SECONDS,
      };
    },
  ),
  route(
    { method: 'get', path: '/v1/news/sources', summary: 'News sources with their feed, terms page and health', tag: 'news', auth: 'none', response: NewsSourcesView, rateLimit: { max: 30, timeWindow: '1 minute' } },
    async (ctx) => {
      const status = await newsOf(ctx.deps).status();
      return {
        refreshEverySeconds: NEWS_REFRESH_SECONDS,
        retentionDays: NEWS_RETENTION_DAYS,
        sources: status.map((s) => ({
          ...sourceView(s.source), feedUrl: s.source.feedUrl, termsUrl: s.source.termsUrl, enabled: s.enabled,
          lastSuccessAt: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
          lastErrorAt: s.lastErrorAt ? new Date(s.lastErrorAt).toISOString() : null,
          lastError: s.lastError, failures: s.failures, itemCount: s.itemCount,
        })),
      };
    },
  ),
  route(
    { method: 'get', path: '/v1/cron/news', summary: 'Reads every news feed that is due (Bearer CRON_SECRET); optional, readers also trigger reads', tag: 'news', auth: 'none', response: NewsCronReport, rateLimit: { max: 30, timeWindow: '1 minute' } },
    async (ctx) => {
      const secret = ctx.deps.config.CRON_SECRET;
      if (!secret) throw new ApiError(503, 'CRON_NOT_CONFIGURED', 'set CRON_SECRET to enable scheduled jobs');
      if (!bearerIs(ctx.req.headers.authorization, secret)) throw new ApiError(401, 'UNAUTHENTICATED', 'cron secret required');
      return newsOf(ctx.deps).refreshDue();
    },
  ),
];
