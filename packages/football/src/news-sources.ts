/**
 * Football news sources: publisher RSS/Atom feeds, read server-side. Only metadata is kept
 * (headline, the publisher's own teaser, time, link); every item links to the original article.
 *
 * Adding a source is one entry here. A source can be switched off without a deploy by setting
 * `enabled = false` on its `news_sources` row, or for one environment with NEWS_SOURCES_DISABLED.
 * Each entry names the publisher's terms page so the owner can review reuse terms per source.
 */

export const NEWS_REGIONS = ['global', 'africa', 'europe', 'asia', 'north-america', 'south-america', 'oceania'] as const;
export type NewsRegion = (typeof NEWS_REGIONS)[number];

export interface NewsSource {
  /** Stable id, also the primary key of the `news_sources` row. */
  id: string;
  /** Publisher name shown on every card. */
  publisher: string;
  /** Section or feed name, shown next to the publisher when it adds something ("African football"). */
  section: string | null;
  feedUrl: string;
  homepage: string;
  termsUrl: string;
  language: 'en' | 'ar';
  region: NewsRegion;
  /** Country focus, when the feed has one (ISO 3166-1 alpha-2). */
  country: string | null;
  /** Article links must point at one of these hosts (or a subdomain); others are dropped. */
  linkHosts: string[];
  /** Show the feed's thumbnails. Off unless the publisher's terms clearly allow it. */
  images: boolean;
  enabledByDefault: boolean;
}

export const NEWS_SOURCES: NewsSource[] = [
  {
    id: 'bbc-football', publisher: 'BBC Sport', section: 'Football', feedUrl: 'https://feeds.bbci.co.uk/sport/football/rss.xml',
    homepage: 'https://www.bbc.co.uk/sport/football', termsUrl: 'https://www.bbc.co.uk/usingthebbc/terms',
    language: 'en', region: 'europe', country: 'GB', linkHosts: ['bbc.co.uk', 'bbc.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'bbc-african-football', publisher: 'BBC Sport', section: 'African football', feedUrl: 'https://feeds.bbci.co.uk/sport/africa/rss.xml',
    homepage: 'https://www.bbc.co.uk/sport/africa', termsUrl: 'https://www.bbc.co.uk/usingthebbc/terms',
    language: 'en', region: 'africa', country: null, linkHosts: ['bbc.co.uk', 'bbc.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'guardian-football', publisher: 'The Guardian', section: 'Football', feedUrl: 'https://www.theguardian.com/football/rss',
    homepage: 'https://www.theguardian.com/football', termsUrl: 'https://www.theguardian.com/help/terms-of-service',
    language: 'en', region: 'europe', country: 'GB', linkHosts: ['theguardian.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'guardian-mls', publisher: 'The Guardian', section: 'MLS', feedUrl: 'https://www.theguardian.com/football/mls/rss',
    homepage: 'https://www.theguardian.com/football/mls', termsUrl: 'https://www.theguardian.com/help/terms-of-service',
    language: 'en', region: 'north-america', country: 'US', linkHosts: ['theguardian.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'guardian-a-league', publisher: 'The Guardian', section: 'A-League', feedUrl: 'https://www.theguardian.com/football/a-league/rss',
    homepage: 'https://www.theguardian.com/football/a-league', termsUrl: 'https://www.theguardian.com/help/terms-of-service',
    language: 'en', region: 'oceania', country: 'AU', linkHosts: ['theguardian.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'guardian-copa-libertadores', publisher: 'The Guardian', section: 'Copa Libertadores', feedUrl: 'https://www.theguardian.com/football/copa-libertadores/rss',
    homepage: 'https://www.theguardian.com/football/copa-libertadores', termsUrl: 'https://www.theguardian.com/help/terms-of-service',
    language: 'en', region: 'south-america', country: null, linkHosts: ['theguardian.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'guardian-saudi-pro-league', publisher: 'The Guardian', section: 'Saudi Pro League', feedUrl: 'https://www.theguardian.com/football/saudi-pro-league/rss',
    homepage: 'https://www.theguardian.com/football/saudi-pro-league', termsUrl: 'https://www.theguardian.com/help/terms-of-service',
    language: 'en', region: 'asia', country: 'SA', linkHosts: ['theguardian.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'sky-sports-football', publisher: 'Sky Sports', section: 'Football', feedUrl: 'https://www.skysports.com/rss/11095',
    homepage: 'https://www.skysports.com/football', termsUrl: 'https://www.skysports.com/terms-and-conditions',
    language: 'en', region: 'europe', country: 'GB', linkHosts: ['skysports.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'cbs-soccer', publisher: 'CBS Sports', section: 'Soccer', feedUrl: 'https://www.cbssports.com/rss/headlines/soccer/',
    homepage: 'https://www.cbssports.com/soccer/', termsUrl: 'https://www.cbssports.com/info/terms',
    language: 'en', region: 'north-america', country: 'US', linkHosts: ['cbssports.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'kingfut', publisher: 'KingFut', section: null, feedUrl: 'https://feeds.feedburner.com/KingFut',
    homepage: 'https://www.kingfut.com/', termsUrl: 'https://www.kingfut.com/',
    language: 'en', region: 'africa', country: 'EG', linkHosts: ['kingfut.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'nilesports', publisher: 'NileSports', section: null, feedUrl: 'https://nilesports.com/feed/',
    homepage: 'https://nilesports.com/', termsUrl: 'https://nilesports.com/',
    language: 'en', region: 'africa', country: 'EG', linkHosts: ['nilesports.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'france24-arabic-sport', publisher: 'فرانس 24', section: 'رياضة', feedUrl: 'https://www.france24.com/ar/%D8%B1%D9%8A%D8%A7%D8%B6%D8%A9/rss',
    homepage: 'https://www.france24.com/ar/', termsUrl: 'https://www.france24.com/ar/',
    language: 'ar', region: 'global', country: null, linkHosts: ['france24.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'skynewsarabia-sport', publisher: 'سكاي نيوز عربية', section: 'رياضة', feedUrl: 'https://www.skynewsarabia.com/rss/sport.xml',
    homepage: 'https://www.skynewsarabia.com/sport', termsUrl: 'https://www.skynewsarabia.com/',
    language: 'ar', region: 'global', country: null, linkHosts: ['skynewsarabia.com'], images: false, enabledByDefault: true,
  },
  {
    id: 'kooora', publisher: 'Kooora', section: null, feedUrl: 'https://feeds.feedburner.com/kooora/Wnpe',
    homepage: 'https://www.kooora.com/', termsUrl: 'https://www.kooora.com/',
    language: 'ar', region: 'global', country: null, linkHosts: ['kooora.com'], images: false, enabledByDefault: true,
  },
];

export function newsSource(id: string): NewsSource | undefined {
  return NEWS_SOURCES.find((s) => s.id === id);
}
