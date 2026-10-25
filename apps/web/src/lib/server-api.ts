import 'server-only';
import { publicEnv } from './env';
import type { MatchDetailResponse, SeoProfileView, SitemapView, StandingsView, TeamMatchesView, VideoView } from './types';

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

/** Indexable profiles and videos for sitemap.xml; null when the API is unreachable. */
export function fetchSitemap(): Promise<SitemapView | null> {
  return getJson<SitemapView>('/v1/sitemap', 3600);
}

const FOOTBALL_ID = /^[A-Za-z0-9~_-]{1,130}$/;

/** A match for page metadata; null when unknown, unavailable or the id is malformed. */
export function fetchMatchMeta(id: string): Promise<MatchDetailResponse | null> {
  return FOOTBALL_ID.test(id) ? getJson<MatchDetailResponse>(`/v1/football/matches/${encodeURIComponent(id)}`, 60) : Promise.resolve(null);
}

export function fetchTeamMeta(id: string): Promise<TeamMatchesView | null> {
  return FOOTBALL_ID.test(id) ? getJson<TeamMatchesView>(`/v1/football/teams/${encodeURIComponent(id)}`, 300) : Promise.resolve(null);
}

export function fetchStandingsMeta(id: string): Promise<StandingsView | null> {
  return FOOTBALL_ID.test(id) ? getJson<StandingsView>(`/v1/football/competitions/${encodeURIComponent(id)}/standings`, 600) : Promise.resolve(null);
}
