import { sql } from 'kysely';
import type { Database } from '@fp/db';
import { NEWS_SOURCES, ProviderError, fetchFeed, parseFeed, titleKey, type FetchLike, type NewsItem, type NewsSource } from '@fp/football';
import { newId } from './ids.js';

interface Logger {
  warn(obj: object, msg: string): void;
}

/** How often a healthy feed is read. Publishers update every few minutes at most; this keeps us polite. */
export const NEWS_REFRESH_SECONDS = 10 * 60;
/** A claimed feed is not claimed again for this long, so a frozen serverless call cannot block it for good. */
const CLAIM_SECONDS = 120;
const MAX_BACKOFF_SECONDS = 6 * 3600;
/** Articles older than this are deleted: the feed is a news ticker, not an archive. */
export const NEWS_RETENTION_DAYS = 30;
/** Same headline from another source within this window counts as the same story. */
const SAME_STORY_HOURS = 48;

export interface RefreshReport {
  attempted: number;
  succeeded: number;
  notModified: number;
  failed: { source: string; kind: string }[];
  inserted: number;
  skippedDuplicates: number;
}

export interface NewsQuery {
  region?: string;
  language?: string;
  topic?: string;
  source?: string;
  q?: string;
  rumours?: boolean;
  before?: { at: Date; id: string };
  limit: number;
}

/**
 * Football news read from publisher feeds into Postgres. Reads are served from the database; feeds
 * are fetched at most every NEWS_REFRESH_SECONDS per source, by whichever API instance claims the
 * source first (an atomic UPDATE), so visitors never multiply publisher requests. A failing feed
 * backs off exponentially and never removes articles already stored.
 */
export class NewsService {
  private synced = false;
  private inflight: Promise<RefreshReport> | null = null;

  constructor(
    private readonly db: Database,
    private readonly now: () => Date,
    private readonly opts: { disabled?: Set<string>; fetchImpl?: FetchLike; sources?: NewsSource[]; log?: Logger } = {},
  ) {}

  get sources(): NewsSource[] {
    return (this.opts.sources ?? NEWS_SOURCES).filter((s) => !this.opts.disabled?.has(s.id));
  }

  source(id: string): NewsSource | undefined {
    return this.sources.find((s) => s.id === id);
  }

  /** Creates a state row for every source in code; existing rows (and their `enabled` switch) are kept. */
  private async syncSources() {
    if (this.synced) return;
    const all = this.opts.sources ?? NEWS_SOURCES;
    await this.db.insertInto('news_sources')
      // Due at once, by the service clock (the database clock may differ from the app's).
      .values(all.map((s) => ({ id: s.id, enabled: s.enabledByDefault, next_fetch_at: this.now() })))
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    this.synced = true;
  }

  /** Fetches every enabled source that is due. Concurrent calls in one instance share one run. */
  refreshDue(): Promise<RefreshReport> {
    if (!this.inflight) this.inflight = this.runRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Refreshes due sources but answers within `budgetMs`; whatever finishes later is stored when it finishes. */
  async refreshWithin(budgetMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.refreshDue().catch((err: unknown) => this.opts.log?.warn({ err: String(err) }, 'news refresh failed')),
      new Promise((r) => { timer = setTimeout(r, budgetMs); }),
    ]);
    clearTimeout(timer);
  }

  private async runRefresh(): Promise<RefreshReport> {
    await this.syncSources();
    const report: RefreshReport = { attempted: 0, succeeded: 0, notModified: 0, failed: [], inserted: 0, skippedDuplicates: 0 };
    const ids = this.sources.map((s) => s.id);
    if (!ids.length) return report;
    const now = this.now();
    const claimed = await this.db.updateTable('news_sources')
      .set({ next_fetch_at: new Date(now.getTime() + CLAIM_SECONDS * 1000), last_attempt_at: now })
      .where('id', 'in', ids).where('enabled', '=', true).where('next_fetch_at', '<=', now)
      .returning(['id', 'etag', 'last_modified', 'failures'])
      .execute();
    report.attempted = claimed.length;
    let storing: Promise<unknown> = Promise.resolve();

    await Promise.all(claimed.map(async (row) => {
      const source = this.source(row.id)!;
      try {
        const res = await fetchFeed(source.feedUrl, { etag: row.etag, lastModified: row.last_modified }, { fetchImpl: this.opts.fetchImpl });
        let count: number | null = null;
        if (res.notModified) report.notModified++;
        else {
          const parsed = parseFeed(res.body ?? '', source, this.now());
          if (!parsed.length) throw new ProviderError('bad_response', 'feed has no usable items');
          // A feed whose items are all past the retention window is a dead feed: nothing is stored
          // and it reports zero recent items, so it can be switched off.
          const cutoff = new Date(this.now().getTime() - NEWS_RETENTION_DAYS * 86400_000).toISOString();
          const items = parsed.filter((i) => i.publishedAt >= cutoff);
          // Feeds download in parallel but are stored one at a time, so the same story from two
          // sources in one run is recognised as a duplicate.
          const stored = items.length ? storing.then(() => this.store(source, items)) : Promise.resolve({ inserted: 0, duplicates: 0 });
          storing = stored.catch(() => {});
          const r = await stored;
          report.inserted += r.inserted;
          report.skippedDuplicates += r.duplicates;
          count = items.length;
        }
        const done = this.now();
        await this.db.updateTable('news_sources')
          .set({
            failures: 0, last_success_at: done, last_error: null, next_fetch_at: new Date(done.getTime() + NEWS_REFRESH_SECONDS * 1000),
            ...(res.notModified ? {} : { etag: res.etag?.slice(0, 300) ?? null, last_modified: res.lastModified?.slice(0, 100) ?? null }),
            ...(count !== null ? { item_count: count } : {}),
          })
          .where('id', '=', source.id).execute();
        report.succeeded++;
      } catch (err) {
        const kind = err instanceof ProviderError ? err.kind : 'internal';
        const n = row.failures + 1;
        // A wrong or gone feed URL is checked a few times a day; temporary failures back off from 10 minutes.
        const wait = kind === 'not_supported' ? MAX_BACKOFF_SECONDS : Math.min(NEWS_REFRESH_SECONDS * 2 ** (n - 1), MAX_BACKOFF_SECONDS);
        const at = this.now();
        report.failed.push({ source: source.id, kind });
        this.opts.log?.warn({ source: source.id, kind, failures: n, err: err instanceof ProviderError ? err.message : String(err) }, 'news feed failed');
        await this.db.updateTable('news_sources')
          .set({
            failures: n, last_error: (err instanceof ProviderError ? `${kind}: ${err.message}` : kind).slice(0, 300), last_error_at: at,
            next_fetch_at: new Date(at.getTime() + wait * 1000),
          })
          .where('id', '=', source.id).execute()
          .catch(() => {});
      }
    }));

    await this.db.deleteFrom('news_articles').where('published_at', '<', new Date(now.getTime() - NEWS_RETENTION_DAYS * 86400_000)).execute()
      .catch((err: unknown) => this.opts.log?.warn({ err: String(err) }, 'could not prune old news'));
    return report;
  }

  /**
   * Inserts new articles and refreshes the headline/teaser of known ones (publishers correct them).
   * The publisher's publication time is kept as first seen. A headline another source already
   * carried in the last 48 hours is skipped, so syndicated stories appear once.
   */
  private async store(source: NewsSource, items: NewsItem[]): Promise<{ inserted: number; duplicates: number }> {
    const keys = items.map((i) => titleKey(i.title));
    const since = new Date(this.now().getTime() - SAME_STORY_HOURS * 3600_000);
    const existing = await this.db.selectFrom('news_articles').select(['url', 'title', 'summary', 'title_key', 'source_id'])
      .where((eb) => eb.or([eb('url', 'in', items.map((i) => i.url)), eb.and([eb('title_key', 'in', keys), eb('published_at', '>=', since)])]))
      .execute();
    const known = new Map(existing.map((e) => [e.url, e]));
    const otherSourceKeys = new Set(existing.filter((e) => e.source_id !== source.id).map((e) => e.title_key));
    const now = this.now();
    const fresh: NewsItem[] = [];
    let duplicates = 0;
    for (const [i, item] of items.entries()) {
      const key = keys[i]!;
      const had = known.get(item.url);
      if (had) {
        if (had.source_id === source.id && (had.title !== item.title || had.summary !== item.summary)) {
          await this.db.updateTable('news_articles')
            .set({ title: item.title, title_key: key, summary: item.summary, image_url: item.imageUrl, topics: item.topics, rumour: item.rumour, updated_at: now })
            .where('url', '=', item.url).execute();
        }
      } else if (key && otherSourceKeys.has(key)) duplicates++;
      else {
        fresh.push(item);
        otherSourceKeys.add(key);
      }
    }
    if (!fresh.length) return { inserted: 0, duplicates };
    const rows = await this.db.insertInto('news_articles')
      .values(fresh.map((item) => ({
        id: newId(), source_id: source.id, url: item.url, title: item.title, title_key: titleKey(item.title), summary: item.summary, image_url: item.imageUrl,
        language: source.language, region: source.region, country: source.country, topics: item.topics, rumour: item.rumour,
        published_at: item.publishedAt, imported_at: now, updated_at: now,
      })))
      .onConflict((oc) => oc.column('url').doNothing())
      .returning('id')
      .execute();
    const inserted = rows.length;
    return { inserted, duplicates };
  }

  /** Articles, newest publication first, only from sources that are enabled in code, config and database. */
  async list(q: NewsQuery) {
    await this.syncSources();
    const ids = this.sources.map((s) => s.id);
    if (!ids.length) return [];
    let query = this.db.selectFrom('news_articles')
      .innerJoin('news_sources', 'news_sources.id', 'news_articles.source_id')
      .select(['news_articles.id', 'source_id', 'url', 'title', 'summary', 'image_url', 'language', 'region', 'country', 'topics', 'rumour', 'published_at', 'imported_at'])
      .where('news_sources.enabled', '=', true)
      .where('source_id', 'in', ids);
    if (q.source) query = query.where('source_id', '=', q.source);
    if (q.region) query = query.where('region', '=', q.region);
    if (q.language) query = query.where('language', '=', q.language);
    if (q.topic) query = query.where(sql<boolean>`${q.topic} = ANY(topics)`);
    if (q.rumours === false) query = query.where('rumour', '=', false);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where((eb) => eb.or([eb('title', 'ilike', like), eb('summary', 'ilike', like)]));
    }
    if (q.before) {
      const { at, id } = q.before;
      query = query.where((eb) => eb.or([eb('published_at', '<', at), eb.and([eb('published_at', '=', at), eb('news_articles.id', '<', id)])]));
    }
    return query.orderBy('published_at', 'desc').orderBy('news_articles.id', 'desc').limit(q.limit).execute();
  }

  /** Every source with its health, for the news page footer and operations. */
  async status() {
    await this.syncSources();
    const rows = await this.db.selectFrom('news_sources').selectAll().execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return this.sources.map((s) => {
      const r = byId.get(s.id);
      return {
        source: s,
        enabled: r?.enabled ?? s.enabledByDefault,
        lastSuccessAt: r?.last_success_at ?? null,
        lastErrorAt: r?.last_error_at ?? null,
        lastError: r?.last_error ?? null,
        failures: r?.failures ?? 0,
        itemCount: r?.item_count ?? 0,
      };
    });
  }

  /** Most recent successful read of any enabled source. */
  async lastUpdate(): Promise<Date | null> {
    const r = await this.db.selectFrom('news_sources').select(sql<Date | null>`max(last_success_at)`.as('at'))
      .where('enabled', '=', true).where('id', 'in', this.sources.map((s) => s.id).concat(['']))
      .executeTakeFirst();
    return r?.at ? new Date(r.at) : null;
  }

  /** True when at least one enabled source is due for a read. */
  async needsRefresh(): Promise<boolean> {
    await this.syncSources();
    const r = await this.db.selectFrom('news_sources').select(sql<number>`count(*)::int`.as('n'))
      .where('enabled', '=', true).where('id', 'in', this.sources.map((s) => s.id).concat(['']))
      .where('next_fetch_at', '<=', this.now())
      .executeTakeFirst();
    return Number(r?.n ?? 0) > 0;
  }
}
