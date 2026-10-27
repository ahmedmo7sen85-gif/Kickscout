import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewsSource } from '@fp/football';
import { createTestEnv, type TestEnv } from './helpers.js';

type Json = Record<string, any>;

const T0 = new Date('2026-10-27T15:00:00Z');
let clock = T0;
const advance = (seconds: number) => { clock = new Date(clock.getTime() + seconds * 1000); };

const src = (id: string, over: Partial<NewsSource>): NewsSource => ({
  id, publisher: id.toUpperCase(), section: null, feedUrl: `https://${id}.example/rss`, homepage: `https://${id}.example/`, termsUrl: `https://${id}.example/terms`,
  language: 'en', region: 'europe', country: null, linkHosts: [`${id}.example`], images: false, enabledByDefault: true, ...over,
});
const SOURCES = [
  src('alpha', { region: 'europe' }),
  src('beta', { region: 'africa', country: 'EG' }),
  src('gamma', { language: 'ar', region: 'africa', country: 'EG' }),
  src('broken', {}),
];

const item = (host: string, slug: string, title: string, at: string, extra = '') =>
  `<item><title>${title}</title><link>https://${host}/${slug}</link><pubDate>${at}</pubDate>${extra}</item>`;
const rss = (items: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items.join('')}</channel></rss>`;

const feeds: Record<string, () => Response> = {
  'https://alpha.example/rss': () => new Response(rss([
    item('alpha.example', 'a1', 'Club A sign striker on loan', 'Tue, 27 Oct 2026 14:00:00 GMT', '<description>The forward joins until June.</description>'),
    item('alpha.example', 'a2', 'Club B 2-1 Club C', 'Tue, 27 Oct 2026 12:00:00 GMT'),
    item('alpha.example', 'a3', 'Transfer gossip: Club D eye keeper', 'Tue, 27 Oct 2026 10:00:00 GMT'),
  ]), { headers: { etag: '"alpha-1"' } }),
  'https://beta.example/rss': () => new Response(rss([
    item('beta.example', 'b1', 'Al Ahly coach sacked after defeat', 'Tue, 27 Oct 2026 13:00:00 GMT'),
    // Same story as alpha's a2, syndicated: shown once.
    item('beta.example', 'b2', 'Club B 2–1 Club C', 'Tue, 27 Oct 2026 12:05:00 GMT'),
  ])),
  'https://gamma.example/rss': () => new Response(rss([item('gamma.example', 'g1', 'إصابة لاعب الزمالك', 'Tue, 27 Oct 2026 11:00:00 GMT')])),
  'https://broken.example/rss': () => new Response('down', { status: 503 }),
};
const calls: { url: string; headers: Record<string, string> }[] = [];
let alphaNotModified = false;

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv({}, {
    news: {
      sources: SOURCES,
      fetchImpl: async (url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url, headers });
        if (url === 'https://alpha.example/rss' && alphaNotModified && headers['If-None-Match'] === '"alpha-1"') return new Response(null, { status: 304 });
        const f = feeds[url];
        if (!f) throw new TypeError('unknown host');
        return f();
      },
    },
  });
  env.deps.now = () => clock;
});
afterAll(async () => {
  await env?.close();
});

async function call(url: string, headers: Record<string, string> = {}) {
  const res = await env.app.inject({ method: 'GET', url, headers });
  return { status: res.statusCode, body: res.json() as Json };
}

describe('football news', () => {
  it('reads the feeds on first request and lists real items newest first, with publisher and original link', async () => {
    const r = await call('/v1/news');
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: Json) => i.url)).toEqual([
      'https://alpha.example/a1', 'https://beta.example/b1', 'https://alpha.example/a2', 'https://gamma.example/g1', 'https://alpha.example/a3',
    ]);
    const first = r.body.items[0];
    expect(first).toMatchObject({ title: 'Club A sign striker on loan', summary: 'The forward joins until June.', publishedAt: '2026-10-27T14:00:00.000Z', importedAt: T0.toISOString(), rumour: false });
    expect(first.source).toMatchObject({ id: 'alpha', publisher: 'ALPHA', homepage: 'https://alpha.example/' });
    expect(first.topics).toContain('transfers');
    expect(r.body.updatedAt).toBe(T0.toISOString());
    expect(r.body.failingSources).toEqual([{ id: 'broken', name: 'BROKEN' }]);
  });

  it('shows a syndicated story once and labels publisher-labelled gossip as rumour', async () => {
    const r = await call('/v1/news');
    expect(r.body.items.filter((i: Json) => /Club B 2/.test(i.title))).toHaveLength(1);
    expect(r.body.items.find((i: Json) => i.url.endsWith('/a3')).rumour).toBe(true);
    expect((await call('/v1/news?rumours=exclude')).body.items.some((i: Json) => i.rumour)).toBe(false);
  });

  it('does not read feeds again before they are due', async () => {
    const before = calls.length;
    advance(60);
    await call('/v1/news');
    expect(calls.length).toBe(before);
  });

  it('filters by region, language, topic, source and text', async () => {
    expect((await call('/v1/news?region=africa')).body.items.map((i: Json) => i.source.id)).toEqual(['beta', 'gamma']);
    expect((await call('/v1/news?language=ar')).body.items.map((i: Json) => i.url)).toEqual(['https://gamma.example/g1']);
    expect((await call('/v1/news?topic=injuries')).body.items.map((i: Json) => i.url)).toEqual(['https://gamma.example/g1']);
    expect((await call('/v1/news?topic=managers')).body.items.map((i: Json) => i.url)).toEqual(['https://beta.example/b1']);
    expect((await call('/v1/news?source=beta')).body.items).toHaveLength(1);
    expect((await call('/v1/news?q=ahly')).body.items.map((i: Json) => i.url)).toEqual(['https://beta.example/b1']);
    expect((await call('/v1/news?q=100%25')).body.items).toEqual([]);
    expect((await call('/v1/news?source=nope')).status).toBe(400);
  });

  it('pages with a cursor without repeating items', async () => {
    const p1 = await call('/v1/news?limit=2');
    expect(p1.body.items).toHaveLength(2);
    const p2 = await call(`/v1/news?limit=2&cursor=${p1.body.nextCursor}`);
    const p3 = await call(`/v1/news?limit=2&cursor=${p2.body.nextCursor}`);
    const urls = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((i: Json) => i.url);
    expect(new Set(urls).size).toBe(5);
    expect(p3.body.nextCursor).toBeNull();
  });

  it('re-reads due feeds with validators, keeps articles when a feed fails, and backs off', async () => {
    alphaNotModified = true;
    feeds['https://beta.example/rss'] = () => new Response('<html>maintenance</html>', { status: 200 });
    advance(11 * 60);
    const before = calls.length;
    const r = await call('/v1/news');
    const fresh = calls.slice(before);
    expect(fresh.find((c) => c.url === 'https://alpha.example/rss')?.headers['If-None-Match']).toBe('"alpha-1"');
    expect(r.body.items.some((i: Json) => i.source.id === 'beta')).toBe(true);
    expect(r.body.failingSources.map((f: Json) => f.id).sort()).toEqual(['beta', 'broken']);
    const s = await call('/v1/news/sources');
    const beta = s.body.sources.find((x: Json) => x.id === 'beta');
    expect(beta).toMatchObject({ enabled: true, failures: 1, termsUrl: 'https://beta.example/terms' });
    expect(beta.lastError).toMatch(/bad_response/);
    expect(s.body.sources.find((x: Json) => x.id === 'broken')).toMatchObject({ failures: 2 });
  });

  it('hides a source switched off in the database', async () => {
    await env.db.updateTable('news_sources').set({ enabled: false }).where('id', '=', 'gamma').execute();
    expect((await call('/v1/news')).body.items.some((i: Json) => i.source.id === 'gamma')).toBe(false);
    await env.db.updateTable('news_sources').set({ enabled: true }).where('id', '=', 'gamma').execute();
  });

  it('runs the scheduled read only with the cron secret', async () => {
    expect((await call('/v1/cron/news')).status).toBe(401);
    advance(30 * 60);
    const r = await call('/v1/cron/news', { authorization: 'Bearer cron-secret-for-tests-0123456789' });
    expect(r.status).toBe(200);
    expect(r.body.attempted).toBeGreaterThan(0);
  });

  it('deletes articles past the retention window', async () => {
    advance(31 * 86400);
    await call('/v1/cron/news', { authorization: 'Bearer cron-secret-for-tests-0123456789' });
    const left = await env.db.selectFrom('news_articles').select('url').where('published_at', '<', new Date('2026-10-28T00:00:00Z')).execute();
    expect(left).toEqual([]);
  });
});
