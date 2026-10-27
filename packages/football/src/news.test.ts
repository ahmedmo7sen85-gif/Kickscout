import { describe, expect, it } from 'vitest';
import {
  canonicalArticleUrl, feedDate, fetchFeed, isRumour, NEWS_SOURCES, newsSource, parseFeed, plainText, ProviderError, shorten, titleKey, topicsFor,
  type NewsSource,
} from './index.js';

const now = new Date('2026-10-27T15:00:00Z');
const bbc = newsSource('bbc-football')!;
const guardian = newsSource('guardian-football')!;

// Shape of the BBC Sport football feed (RSS 2.0 with media:thumbnail); the content is made up for the test.
const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE rss [<!ENTITY boom "boom">]>
<rss xmlns:media="http://search.yahoo.com/mrss/" version="2.0"><channel>
  <title><![CDATA[BBC Sport - Football]]></title>
  <item>
    <title><![CDATA[Club A sign striker on loan]]></title>
    <description><![CDATA[The 21-year-old <b>joins</b> until the end of the season &amp; could debut on Saturday.]]></description>
    <link>https://www.bbc.co.uk/sport/football/articles/abc123?at_medium=RSS&amp;at_campaign=rss</link>
    <guid isPermaLink="false">https://www.bbc.co.uk/sport/football/articles/abc123#0</guid>
    <pubDate>Tue, 27 Oct 2026 13:05:00 GMT</pubDate>
    <media:thumbnail width="240" height="135" url="https://ichef.bbci.co.uk/x.jpg"/>
  </item>
  <item>
    <title>Gossip: Club B want Club C defender</title>
    <description>Gossip: Club B want Club C defender</description>
    <link>https://www.bbc.co.uk/sport/football/articles/def456</link>
    <pubDate>Tue, 27 Oct 2026 14:30:00 GMT</pubDate>
  </item>
  <item>
    <title>Duplicate of the first</title>
    <link>https://www.bbc.co.uk/sport/football/articles/abc123?at_campaign=other</link>
    <pubDate>Tue, 27 Oct 2026 12:00:00 GMT</pubDate>
  </item>
  <item><title>No date</title><link>https://www.bbc.co.uk/sport/football/articles/nodate</link></item>
  <item><title>Elsewhere</title><link>https://evil.example/phish</link><pubDate>Tue, 27 Oct 2026 12:00:00 GMT</pubDate></item>
  <item><title>From the future</title><link>https://www.bbc.co.uk/sport/football/articles/future</link><pubDate>Wed, 28 Oct 2026 12:00:00 GMT</pubDate></item>
  <item><title></title><link>https://www.bbc.co.uk/sport/football/articles/notitle</link><pubDate>Tue, 27 Oct 2026 12:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Football | The Guardian</title>
  <entry>
    <title type="html">Team X 2-1 Team Y: match report</title>
    <link rel="alternate" href="https://www.theguardian.com/football/2026/oct/27/report"/>
    <published>2026-10-27T11:00:00Z</published>
    <summary type="html">&lt;p&gt;A late winner settled it.&lt;/p&gt;</summary>
    <category term="Football"/>
  </entry>
</feed>`;

describe('news feed parsing', () => {
  it('keeps only items with a headline, a link on the publisher site and a real past date', () => {
    const items = parseFeed(RSS, bbc, now);
    expect(items.map((i) => i.url)).toEqual([
      'https://www.bbc.co.uk/sport/football/articles/def456',
      'https://www.bbc.co.uk/sport/football/articles/abc123',
    ]);
  });
  it('sorts by publication time and keeps the publisher’s time', () => {
    const [a, b] = parseFeed(RSS, bbc, now);
    expect(a!.publishedAt).toBe('2026-10-27T14:30:00.000Z');
    expect(b!.publishedAt).toBe('2026-10-27T13:05:00.000Z');
  });
  it('turns summaries into short plain text and drops a summary that only repeats the headline', () => {
    const items = parseFeed(RSS, bbc, now);
    expect(items[1]!.summary).toBe('The 21-year-old joins until the end of the season & could debut on Saturday.');
    expect(items[0]!.summary).toBeNull();
  });
  it('labels rumours only when the publisher does, and detects topics', () => {
    const [gossip, signing] = parseFeed(RSS, bbc, now);
    expect(gossip!.rumour).toBe(true);
    expect(signing!.rumour).toBe(false);
    expect(signing!.topics).toContain('transfers');
  });
  it('does not show thumbnails unless the source allows images', () => {
    expect(parseFeed(RSS, bbc, now)[1]!.imageUrl).toBeNull();
    const withImages: NewsSource = { ...bbc, images: true };
    expect(parseFeed(RSS, withImages, now)[1]!.imageUrl).toBe('https://ichef.bbci.co.uk/x.jpg');
  });
  it('reads Atom feeds', () => {
    const [item] = parseFeed(ATOM, guardian, now);
    expect(item).toMatchObject({ url: 'https://www.theguardian.com/football/2026/oct/27/report', summary: 'A late winner settled it.', publishedAt: '2026-10-27T11:00:00.000Z' });
    expect(item!.topics).toContain('match-report');
  });
  it('refuses documents that are not feeds', () => {
    expect(() => parseFeed('<html><body>hi</body></html>', bbc, now)).toThrow(ProviderError);
    expect(() => parseFeed('x'.repeat(2_000_001), bbc, now)).toThrow(/too large/);
  });
});

describe('news helpers', () => {
  it('canonicalises links and refuses other hosts', () => {
    expect(canonicalArticleUrl('http://www.bbc.com/sport/a?utm_source=x&id=2#top', ['bbc.com'])).toBe('https://www.bbc.com/sport/a?id=2');
    expect(canonicalArticleUrl('https://bbc.com.evil.example/a', ['bbc.com'])).toBeNull();
    expect(canonicalArticleUrl('javascript:alert(1)', ['bbc.com'])).toBeNull();
  });
  it('strips markup and scripts', () => {
    expect(plainText('<p>Hi <script>alert(1)</script><img src=x onerror=y>there &#8211; ok</p>')).toBe('Hi there – ok');
    // Escaped markup is decoded and then stripped too, so no tag survives into the UI.
    expect(plainText('&lt;b&gt;bold&lt;/b&gt; text')).toBe('bold text');
  });
  it('shortens on a word boundary', () => {
    expect(shorten('one two three four five', 12)).toBe('one two…');
  });
  it('parses RSS and ISO dates and refuses nonsense', () => {
    expect(feedDate('Tue, 27 Oct 2026 13:05:00 +0200', now)).toBe('2026-10-27T11:05:00.000Z');
    expect(feedDate('2026-10-27T11:00:00Z', now)).toBe('2026-10-27T11:00:00.000Z');
    expect(feedDate('soon', now)).toBeNull();
  });
  it('matches the same headline across sources', () => {
    expect(titleKey('Salah: “I’m staying!”')).toBe(titleKey('salah - i m staying'));
  });
  it('labels topics in Arabic and falls back to general', () => {
    expect(topicsFor('إصابة لاعب الأهلي قبل المباراة', [])).toContain('injuries');
    expect(topicsFor('Club statement', [])).toEqual(['general']);
    expect(isRumour('شائعات الانتقالات', [], 'https://x.example/a')).toBe(true);
  });
  it('has unique source ids with https feeds', () => {
    expect(new Set(NEWS_SOURCES.map((s) => s.id)).size).toBe(NEWS_SOURCES.length);
    for (const s of NEWS_SOURCES) expect(s.feedUrl.startsWith('https://')).toBe(true);
  });
});

describe('feed fetching', () => {
  const ok = (body: string, headers: Record<string, string> = {}) => async () => new Response(body, { status: 200, headers });
  it('sends validators and reports 304', async () => {
    let sent: Record<string, string> = {};
    const r = await fetchFeed('https://x.example/rss', { etag: '"v1"', lastModified: null }, {
      fetchImpl: async (_u, init) => { sent = init?.headers as Record<string, string>; return new Response(null, { status: 304 }); },
    });
    expect(sent['If-None-Match']).toBe('"v1"');
    expect(r.notModified).toBe(true);
  });
  it('returns the body and new validators', async () => {
    const r = await fetchFeed('https://x.example/rss', { etag: null, lastModified: null }, { fetchImpl: ok('<rss/>', { etag: '"v2"' }) });
    expect(r).toMatchObject({ notModified: false, body: '<rss/>', etag: '"v2"' });
  });
  it('classifies failures', async () => {
    await expect(fetchFeed('https://x.example/rss', { etag: null, lastModified: null }, { fetchImpl: async () => new Response('', { status: 404 }) })).rejects.toMatchObject({ kind: 'not_supported' });
    await expect(fetchFeed('https://x.example/rss', { etag: null, lastModified: null }, { fetchImpl: async () => new Response('', { status: 503 }) })).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(fetchFeed('https://x.example/rss', { etag: null, lastModified: null }, { fetchImpl: async () => { throw new TypeError('down'); } })).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
