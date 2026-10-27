import { XMLParser } from 'fast-xml-parser';
import { ProviderError } from './types.js';
import type { NewsSource } from './news-sources.js';
import type { FetchLike } from './http.js';

/**
 * Football news from publisher feeds. A feed item becomes a `NewsItem` only when it has a headline,
 * an https link on the publisher's own site and a real publication time; anything else is dropped,
 * never filled in. Summaries are the publisher's own teaser, stripped to plain text and shortened.
 */

export const NEWS_TOPICS = ['transfers', 'injuries', 'match-report', 'managers', 'national-teams', 'talent', 'general'] as const;
export type NewsTopic = (typeof NEWS_TOPICS)[number];

export interface NewsItem {
  sourceId: string;
  /** Canonical article URL (no tracking parameters or fragment): the dedupe key. */
  url: string;
  title: string;
  summary: string | null;
  imageUrl: string | null;
  publishedAt: string;
  topics: NewsTopic[];
  /** True only when the publisher itself presents the item as rumour or gossip. */
  rumour: boolean;
}

export const MAX_FEED_BYTES = 2_000_000;
export const SUMMARY_MAX = 280;
const TITLE_MAX = 300;

// ---------------------------------------------------------------- text helpers

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Plain text from feed HTML: tags, scripts and styles removed, entities decoded, whitespace collapsed. */
export function plainText(v: unknown): string {
  if (typeof v !== 'string') return '';
  return decodeEntities(
    v.replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/h\d>/gi, ' ')
      .replace(/<\/li>/gi, '. ')
      .replace(/<[^>]*>/g, ' '),
  ).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/\.\s+\./g, '.').trim();
}

export function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

const TRACKING = /^(utm_[a-z]+|at_[a-z_]+|ocid|cmpid|ito|CMP|fbclid|gclid|mc_[a-z]+|ns_[a-z]+)$/;

/** https URL on one of the source's hosts, with tracking parameters and fragment removed; otherwise null. */
export function canonicalArticleUrl(v: unknown, hosts: string[]): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hash = '';
  return u.toString();
}

/** A headline key for spotting the same story syndicated twice: letters and digits only. */
export function titleKey(title: string): string {
  return title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 200);
}

// ---------------------------------------------------------------- topics and rumours

const TOPIC_RULES: [NewsTopic, RegExp][] = [
  ['transfers', /\b(transfers?|signs?|signing|signed|loan|bid|fee|move to|joins?|deadline day|release clause|contract)\b|انتقال|صفقة|يوقع|التعاقد|إعارة|عقد/i],
  ['injuries', /\b(injur(y|ies|ed)|ruled out|sidelined|hamstring|ankle|knee|surgery|suspen(ded|sion)|banned|ban)\b|إصابة|مصاب|غياب|إيقاف|موقوف/i],
  ['managers', /\b(manager|head coach|coach|sacked|appoint(s|ed)?|boss|resigns?|interim)\b|مدرب|المدير الفني|إقالة|تعيين|استقالة/i],
  ['national-teams', /\b(world cup|national team|afcon|africa cup of nations|euro 20\d\d|copa am[eé]rica|asian cup|qualif(y|ier|iers|ying)|international break)\b|كأس العالم|المنتخب|منتخب|كأس الأمم|تصفيات/i],
  ['talent', /\b(wonderkid|teenager|teen|youngster|academy|prodigy|u-?1[5-9]|u-?2[0-3]|under-?(1[5-9]|2[0-3])|youth)\b|ناشئ|ناشئين|موهبة|شباب/i],
  ['match-report', /\b(\d{1,2}\s?[-–]\s?\d{1,2}|beat|beats|draw|draws|thrash|thrashes|win over|defeat|stun|stuns|rout|routs|report)\b|تعادل|فوز|يفوز|خسارة|يهزم|بثنائية|بثلاثية|بهدف/i],
];

const RUMOUR = /\b(rumou?rs?|gossip|transfer talk|paper talk)\b|شائعات|شائعة/i;

/** Topics from the headline and the publisher's own categories. A best-effort label, shown as such. */
export function topicsFor(title: string, categories: string[]): NewsTopic[] {
  const text = `${title} ${categories.join(' ')}`;
  const found = TOPIC_RULES.filter(([, re]) => re.test(text)).map(([t]) => t);
  return found.length ? found : ['general'];
}

export function isRumour(title: string, categories: string[], url: string): boolean {
  return RUMOUR.test(title) || categories.some((c) => RUMOUR.test(c)) || /\/(gossip|rumou?rs?)(\/|$|-)/i.test(new URL(url).pathname);
}

// ---------------------------------------------------------------- parsing

type Raw = Record<string, unknown>;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null);

/** Text of an element that may be a string, a CDATA/attribute object, or a number. */
function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  const o = obj(v);
  if (o) return text(o['#text'] ?? o['__cdata'] ?? '');
  return '';
}

function atomLink(v: unknown): string | null {
  const links = asArray(v).map(obj).filter((l): l is Raw => l !== null);
  const alt = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
  if (alt && typeof alt['@_href'] === 'string') return alt['@_href'];
  const s = asArray(v).find((l) => typeof l === 'string');
  return typeof s === 'string' ? s : null;
}

function imageOf(item: Raw): string | null {
  for (const k of ['media:thumbnail', 'media:content', 'enclosure']) {
    for (const m of asArray(item[k]).map(obj)) {
      const url = m?.['@_url'];
      const type = m?.['@_type'];
      if (typeof url === 'string' && (k !== 'enclosure' || (typeof type === 'string' && type.startsWith('image/')))) return url;
    }
  }
  return null;
}

/** Feed timestamps are RFC 822 (RSS) or ISO 8601 (Atom); anything unparseable or in the future is refused. */
export function feedDate(v: unknown, now: Date): string | null {
  const s = text(v).trim();
  if (!s) return null;
  const t = Date.parse(s.replace(/\s+(UT|Z)$/i, ' GMT'));
  if (!Number.isFinite(t)) return null;
  // A few minutes of clock skew is normal; a date further ahead is a publisher error, not news.
  if (t > now.getTime() + 15 * 60_000) return null;
  return new Date(t).toISOString();
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '__cdata',
  processEntities: true,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  trimValues: true,
});

/** Parses RSS 2.0, RSS 1.0 (RDF) and Atom into validated items, newest first, without duplicates. */
export function parseFeed(xml: string, source: NewsSource, now: Date): NewsItem[] {
  if (xml.length > MAX_FEED_BYTES) throw new ProviderError('bad_response', 'feed too large');
  // Feeds have no business defining entities; dropping the DOCTYPE rules out entity expansion.
  const body = xml.replace(/<!DOCTYPE[\s\S]*?(\[[\s\S]*?\])?\s*>/i, '');
  let doc: Raw;
  try {
    doc = parser.parse(body) as Raw;
  } catch {
    throw new ProviderError('bad_response', 'feed is not valid XML');
  }
  const rss = obj(doc.rss);
  const rdf = obj(doc['rdf:RDF']);
  const feed = obj(doc.feed);
  const rawItems = rss ? asArray(obj(rss.channel)?.item) : rdf ? asArray(rdf.item) : feed ? asArray(feed.entry) : null;
  if (!rawItems) throw new ProviderError('bad_response', 'not an RSS or Atom feed');

  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const r of rawItems) {
    const item = obj(r);
    if (!item) continue;
    const title = shorten(plainText(text(item.title)), TITLE_MAX);
    const link = feed ? atomLink(item.link) : text(item.link) || (obj(item.guid)?.['@_isPermaLink'] !== 'false' ? text(item.guid) : '');
    const url = canonicalArticleUrl(link, source.linkHosts);
    const publishedAt = feedDate(item.pubDate ?? item.published ?? item.updated ?? item['dc:date'], now);
    if (!title || !url || !publishedAt || seen.has(url)) continue;
    seen.add(url);
    // Publishers append their own link text ("Continue reading..."); the card has its own link.
    const rawSummary = plainText(text(item.description ?? item.summary ?? item.content)).replace(/\s*(continue reading|read more)\s*(\.+|…)?\s*$/i, '').trim();
    const summary = rawSummary && titleKey(rawSummary) !== titleKey(title) ? shorten(rawSummary, SUMMARY_MAX) : null;
    const categories = asArray(item.category).map((c) => plainText(text(c) || String(obj(c)?.['@_term'] ?? ''))).filter(Boolean);
    const image = source.images ? imageOf(item) : null;
    out.push({
      sourceId: source.id, url, title, summary,
      imageUrl: image && /^https:\/\//.test(image) ? image : null,
      publishedAt, topics: topicsFor(title, categories), rumour: isRumour(title, categories, url),
    });
  }
  return out.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

// ---------------------------------------------------------------- fetching

export interface FeedResponse {
  /** 304: the feed has not changed since the validators we sent. */
  notModified: boolean;
  body: string | null;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Conditional GET of a feed with a timeout and a byte limit. 4xx other than 429 means the feed URL is
 * wrong or gone (`not_supported`); 429/5xx/network errors are temporary and retried on a later run.
 */
export async function fetchFeed(
  url: string,
  validators: { etag: string | null; lastModified: string | null },
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; userAgent?: string } = {},
): Promise<FeedResponse> {
  const doFetch = opts.fetchImpl ?? ((i: string, init?: RequestInit) => fetch(i, init));
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 6000);
  const headers: Record<string, string> = {
    Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1',
    'User-Agent': opts.userAgent ?? 'KICKSCOUT-news/1.0 (+https://kickscout-ten.vercel.app)',
  };
  if (validators.etag) headers['If-None-Match'] = validators.etag;
  if (validators.lastModified) headers['If-Modified-Since'] = validators.lastModified;
  let res: Response;
  try {
    res = await doFetch(url, { headers, signal: timeout, redirect: 'follow' });
  } catch {
    throw new ProviderError(timeout.aborted ? 'timeout' : 'unavailable', timeout.aborted ? 'feed timed out' : 'feed unreachable');
  }
  if (res.status === 304) return { notModified: true, body: null, etag: validators.etag, lastModified: validators.lastModified };
  if (res.status === 429) throw new ProviderError('rate_limited', 'feed rate limit reached');
  if (res.status >= 500) throw new ProviderError('unavailable', `feed error ${res.status}`);
  if (!res.ok) throw new ProviderError('not_supported', `feed answered ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_FEED_BYTES) throw new ProviderError('bad_response', 'feed too large');
  const body = await res.text();
  if (body.length > MAX_FEED_BYTES) throw new ProviderError('bad_response', 'feed too large');
  return { notModified: false, body, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
}
