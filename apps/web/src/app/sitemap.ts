import type { MetadataRoute } from 'next';
import { publicEnv } from '@/lib/env';
import { buildSitemap } from '@/lib/seo';
import { fetchSitemap } from '@/lib/server-api';

/** Regenerated hourly. Profiles and videos come from GET /v1/sitemap, which applies the privacy rules. */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemap(publicEnv.siteUrl, await fetchSitemap());
}
