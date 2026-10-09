/**
 * Page metadata, structured data and sitemap helpers. Pure (no server or browser APIs) so they can
 * be unit-tested. Privacy filtering of profiles and videos is the API's job (GET /v1/sitemap and
 * GET /v1/seo/profiles/:handle only return what may be indexed); this module only formats it.
 */
import type { Metadata, MetadataRoute } from 'next';
import type { Dict } from './i18n';
import { LEGAL_DOCS } from './legal';
import type { SeoProfileView, SitemapView, VideoView } from './types';

/** The brand share card rendered by `app/brand-image/route.tsx`. */
export const BRAND_IMAGE = { url: '/brand-image', width: 1200, height: 630 } as const;

export interface PageMetaInput {
  t: Dict;
  /** The page's own title; omit for the site default. */
  title?: string;
  description?: string;
  /** Site-relative canonical path, e.g. `/discover`. */
  path: string;
  type?: 'website' | 'profile' | 'video.other';
  images?: { url: string; width?: number; height?: number; alt?: string }[];
  noindex?: boolean;
}

/** Title, description, canonical URL and Open Graph / Twitter cards with the brand image by default. */
export function pageMetadata({ t, title, description, path, type = 'website', images, noindex }: PageMetaInput): Metadata {
  const desc = description ?? t.meta.description;
  const shareTitle = title ? `${title} · KICKSCOUT` : t.meta.title;
  const imgs = images?.length ? images : [{ ...BRAND_IMAGE, alt: t.meta.ogAlt }];
  return {
    ...(title ? { title } : {}),
    description: desc,
    alternates: { canonical: path },
    openGraph: { type, siteName: 'KICKSCOUT', title: shareTitle, description: desc, url: path, images: imgs },
    twitter: { card: 'summary_large_image', title: shareTitle, description: desc, images: imgs.map((i) => i.url) },
    ...(noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

/** JSON for a `<script type="application/ld+json">`, safe against `</script>` and line-separator breakouts. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** ISO 8601 duration (`PT1M5S`) from milliseconds. */
export function isoDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `PT${m ? `${m}M` : ''}${s || !m ? `${s}S` : ''}`;
}

const abs = (siteUrl: string, path: string) => (/^https?:\/\//.test(path) ? path : `${siteUrl}${path}`);

export function profileJsonLd(p: SeoProfileView, siteUrl: string, positionLabel?: string | null) {
  const url = `${siteUrl}/u/${encodeURIComponent(p.handle)}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url,
    dateModified: p.updatedAt,
    mainEntity: {
      '@type': 'Person',
      name: p.displayName,
      alternateName: `@${p.handle}`,
      url,
      ...(p.bio ? { description: p.bio } : {}),
      ...(p.avatarUrl ? { image: abs(siteUrl, p.avatarUrl) } : {}),
      ...(positionLabel ? { jobTitle: positionLabel } : {}),
    },
  };
}

export function videoJsonLd(v: VideoView, siteUrl: string, description: string) {
  const url = `${siteUrl}/v/${v.id}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: v.title,
    description,
    url,
    uploadDate: v.publishedAt ?? v.createdAt,
    ...(v.thumbnailUrl ? { thumbnailUrl: [abs(siteUrl, v.thumbnailUrl)] } : {}),
    ...(v.playbackUrl ? { contentUrl: abs(siteUrl, v.playbackUrl) } : {}),
    ...(v.durationMs ? { duration: isoDuration(v.durationMs) } : {}),
    author: { '@type': 'Person', name: v.owner.displayName, url: `${siteUrl}/u/${encodeURIComponent(v.owner.handle)}` },
    interactionStatistic: { '@type': 'InteractionCounter', interactionType: { '@type': 'LikeAction' }, userInteractionCount: v.likes },
  };
}

/** Public pages anyone may index. Signed-in areas, staff tools and forms are never listed. */
export const STATIC_SITEMAP_PATHS = [
  '/', '/home', '/discover', '/radar', '/challenges', '/search', '/for-players', '/for-scouts', '/pricing', '/safety', '/legal', '/legal/takedown',
  ...LEGAL_DOCS.map((d) => `/legal/${d.slug}`),
] as const;

/** Paths robots.txt keeps crawlers out of. */
export const PRIVATE_PATHS = [
  '/admin', '/settings', '/notifications', '/scout', '/org', '/onboarding', '/auth', '/guardian', '/upload', '/profile', '/login', '/signup',
  '/legal/counter-notice',
] as const;

/** The sitemap: static public pages plus whatever the API says is indexable (nothing more when it is unreachable). */
export function buildSitemap(siteUrl: string, data: SitemapView | null, now = new Date()): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = STATIC_SITEMAP_PATHS.map((p) => ({
    url: `${siteUrl}${p === '/' ? '' : p}` || siteUrl,
    lastModified: now,
    changeFrequency: p === '/home' || p === '/discover' || p === '/radar' ? 'hourly' : 'weekly',
    priority: p === '/' ? 1 : 0.6,
  }));
  if (!data) return entries;
  for (const p of data.profiles) entries.push({ url: `${siteUrl}/u/${encodeURIComponent(p.handle)}`, lastModified: new Date(p.updatedAt), changeFrequency: 'daily', priority: 0.7 });
  for (const v of data.videos) entries.push({ url: `${siteUrl}/v/${encodeURIComponent(v.id)}`, lastModified: new Date(v.updatedAt), changeFrequency: 'weekly', priority: 0.5 });
  return entries;
}
