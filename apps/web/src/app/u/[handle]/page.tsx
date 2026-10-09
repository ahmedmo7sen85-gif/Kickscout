import type { Metadata } from 'next';
import { JsonLd } from '@/components/JsonLd';
import { publicEnv } from '@/lib/env';
import { fmt, getDict } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import { pageMetadata, profileJsonLd } from '@/lib/seo';
import { fetchSeoProfile } from '@/lib/server-api';
import type { Position } from '@/lib/types';
import { ProfileView } from './ProfileView';

type Props = { params: Promise<{ handle: string }> };

/**
 * Only profiles the API calls indexable (public, discoverable, not a demo, a minor only with the
 * guardian's public-profile consent) get a description, structured data and `index`. Every other
 * profile page is `noindex` and names nothing beyond the handle already in its URL.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const h = decodeURIComponent(handle);
  const t = getDict(await getLocale());
  const p = await fetchSeoProfile(h);
  const path = `/u/${encodeURIComponent(h)}`;
  if (!p) return pageMetadata({ t, title: `@${h}`, path, type: 'profile', noindex: true });
  const position = p.position ? t.positions[p.position as Position] ?? null : null;
  const description = position
    ? fmt(t.meta.profileDescriptionPosition, { name: p.displayName, handle: p.handle, position })
    : fmt(t.meta.profileDescription, { name: p.displayName, handle: p.handle });
  return pageMetadata({
    t,
    title: `${p.displayName} (@${p.handle})`,
    description,
    path: `/u/${encodeURIComponent(p.handle)}`,
    type: 'profile',
    images: p.avatarUrl ? [{ url: p.avatarUrl, alt: p.displayName }] : undefined,
  });
}

export default async function ProfilePage({ params }: Props) {
  const { handle } = await params;
  const h = decodeURIComponent(handle);
  const p = await fetchSeoProfile(h);
  const t = getDict(await getLocale());
  const position = p?.position ? t.positions[p.position as Position] ?? null : null;
  return (
    <>
      {p ? <JsonLd data={profileJsonLd(p, publicEnv.siteUrl, position)} /> : null}
      <ProfileView handle={h} />
    </>
  );
}
