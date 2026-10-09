import 'server-only';
import { publicEnv } from './env';
import type { SeoChallengeView, SeoProfileView, SitemapView, VideoView } from './types';

/**
 * Server-side, unauthenticated reads used only for SEO metadata. Failures return null so a page
 * still renders (and shows its own client-side state) when the API is unreachable.
 */
export async function fetchPublicVideo(id: string): Promise<VideoView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    const res = await fetch(`${publicEnv.apiUrl}/v1/videos/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2500),
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as VideoView;
  } catch {
    return null;
  }
}

async function getJson<T>(path: string, revalidate: number): Promise<T | null> {
  try {
    const res = await fetch(`${publicEnv.apiUrl}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2500),
      next: { revalidate },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Public facts for an indexable profile; null when the profile may not be indexed (or the API is down). */
export function fetchSeoProfile(handle: string): Promise<SeoProfileView | null> {
  if (!/^[a-zA-Z0-9_.]{3,30}$/.test(handle)) return Promise.resolve(null);
  return getJson<SeoProfileView>(`/v1/seo/profiles/${encodeURIComponent(handle)}`, 300);
}

/** Public facts for an indexable challenge; null when the SEO agent says it should not be indexed (or the API is down). */
export function fetchSeoChallenge(slug: string): Promise<SeoChallengeView | null> {
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) return Promise.resolve(null);
  return getJson<SeoChallengeView>(`/v1/seo/challenges/${encodeURIComponent(slug)}`, 300);
}

/** Indexable profiles, videos and challenges for sitemap.xml; null when the API is unreachable. */
export function fetchSitemap(): Promise<SitemapView | null> {
  return getJson<SitemapView>('/v1/sitemap', 3600);
}
