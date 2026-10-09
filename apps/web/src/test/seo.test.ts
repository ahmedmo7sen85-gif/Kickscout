import { describe, expect, it } from 'vitest';
import robots from '@/app/robots';
import { en } from '@/lib/i18n/en';
import { BRAND_IMAGE, buildSitemap, isoDuration, pageMetadata, PRIVATE_PATHS, profileJsonLd, serializeJsonLd, STATIC_SITEMAP_PATHS, videoJsonLd } from '@/lib/seo';
import type { SeoProfileView, VideoView } from '@/lib/types';

const SITE = 'https://kickscout.test';
const id = '0192e000-0000-7000-8000-000000000001';

describe('page metadata', () => {
  it('sets title, description, canonical and the brand share image', () => {
    const m = pageMetadata({ t: en, title: 'Discover', description: 'Browse.', path: '/discover' });
    expect(m.title).toBe('Discover');
    expect(m.description).toBe('Browse.');
    expect(m.alternates?.canonical).toBe('/discover');
    expect(m.openGraph).toMatchObject({ title: 'Discover · KICKSCOUT', url: '/discover', images: [{ url: BRAND_IMAGE.url, width: 1200, height: 630, alt: en.meta.ogAlt }] });
    expect(m.twitter).toMatchObject({ card: 'summary_large_image', images: [BRAND_IMAGE.url] });
    expect(m.robots).toBeUndefined();
    expect(pageMetadata({ t: en, path: '/u/x', noindex: true }).robots).toEqual({ index: false, follow: false });
  });
});

describe('sitemap and robots', () => {
  it('lists only public pages plus what the API marked indexable', () => {
    const fallback = buildSitemap(SITE, null);
    expect(fallback.map((e) => e.url)).toEqual(STATIC_SITEMAP_PATHS.map((p) => (p === '/' ? SITE : `${SITE}${p}`)));
    const data = { profiles: [{ handle: 'ahmed.10', updatedAt: '2026-10-01T00:00:00.000Z' }], videos: [{ id, updatedAt: '2026-10-02T00:00:00.000Z' }] };
    const urls = buildSitemap(SITE, data).map((e) => e.url);
    expect(urls).toContain(`${SITE}/u/ahmed.10`);
    expect(urls).toContain(`${SITE}/v/${id}`);
    expect(urls).toHaveLength(STATIC_SITEMAP_PATHS.length + 2);
    for (const u of urls) for (const p of PRIVATE_PATHS) expect(u.startsWith(`${SITE}${p}`), u).toBe(false);
  });

  it('keeps crawlers out of private areas and points at the sitemap', () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0]! : r.rules;
    expect(rule.disallow).toEqual(expect.arrayContaining(['/admin', '/settings', '/scout', '/org', '/onboarding', '/guardian', '/upload']));
    expect(r.sitemap).toMatch(/\/sitemap\.xml$/);
  });
});

describe('structured data', () => {
  it('cannot be broken out of with user text', () => {
    const s = serializeJsonLd({ name: '</script><script>alert(1)</script>', bio: 'a\u2028b & c' });
    expect(s).not.toMatch(/<|>|\u2028/);
    expect(JSON.parse(s)).toEqual({ name: '</script><script>alert(1)</script>', bio: 'a\u2028b & c' });
  });

  it('describes a profile as a ProfilePage about a Person', () => {
    const p: SeoProfileView = { handle: 'ahmed.10', displayName: 'Ahmed', bio: null, avatarUrl: '/media/a.jpg', position: 'LW', verified: true, updatedAt: '2026-10-01T00:00:00.000Z' };
    const ld = profileJsonLd(p, SITE, 'Left winger');
    expect(ld).toMatchObject({ '@type': 'ProfilePage', url: `${SITE}/u/ahmed.10`, mainEntity: { '@type': 'Person', name: 'Ahmed', alternateName: '@ahmed.10', image: `${SITE}/media/a.jpg`, jobTitle: 'Left winger' } });
    expect(ld.mainEntity).not.toHaveProperty('description');
  });

  it('describes a video as a VideoObject', () => {
    const v = {
      id, title: 'Elastico', description: null, thumbnailUrl: 'https://cdn.test/t.jpg', playbackUrl: 'https://cdn.test/v.mp4', durationMs: 65_000,
      publishedAt: '2026-10-03T00:00:00.000Z', createdAt: '2026-10-02T00:00:00.000Z', likes: 4,
      owner: { userId: id, handle: 'ahmed.10', displayName: 'Ahmed', avatarUrl: null, verified: false, isDemo: false },
    } as unknown as VideoView;
    expect(videoJsonLd(v, SITE, 'Elastico · #skills')).toMatchObject({
      '@type': 'VideoObject', name: 'Elastico', uploadDate: '2026-10-03T00:00:00.000Z', duration: 'PT1M5S', thumbnailUrl: ['https://cdn.test/t.jpg'],
      contentUrl: 'https://cdn.test/v.mp4', author: { name: 'Ahmed', url: `${SITE}/u/ahmed.10` },
    });
    expect(isoDuration(0)).toBe('PT0S');
    expect(isoDuration(120_000)).toBe('PT2M');
  });
});
