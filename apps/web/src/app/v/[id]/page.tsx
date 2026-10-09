import type { Metadata } from 'next';
import { JsonLd } from '@/components/JsonLd';
import { publicEnv } from '@/lib/env';
import { getDict, type Dict } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import { pageMetadata, videoJsonLd } from '@/lib/seo';
import { fetchPublicVideo, fetchSeoProfile } from '@/lib/server-api';
import type { VideoView } from '@/lib/types';
import { VideoDetail } from './VideoDetail';

type Props = { params: Promise<{ id: string }> };

/** The video, only when it is public, published and its owner's profile may be indexed. */
async function indexableVideo(id: string): Promise<VideoView | null> {
  const v = await fetchPublicVideo(id);
  if (!v || v.status !== 'published' || v.visibility !== 'public' || v.owner.isDemo) return null;
  return (await fetchSeoProfile(v.owner.handle)) ? v : null;
}

function describe(v: VideoView, t: Dict): string {
  const skill = v.skill ? t.skills[v.skill] : null;
  return v.description || [skill, ...v.hashtags.map((h) => `#${h}`)].filter(Boolean).join(' · ') || t.meta.description;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const t = getDict(await getLocale());
  const v = await indexableVideo(id);
  if (!v) return pageMetadata({ t, path: `/v/${encodeURIComponent(id)}`, noindex: true });
  return pageMetadata({
    t,
    title: `${v.title} · @${v.owner.handle}`,
    description: describe(v, t),
    path: `/v/${v.id}`,
    type: 'video.other',
    images: v.thumbnailUrl ? [{ url: v.thumbnailUrl, width: 720, height: 1280, alt: v.title }] : undefined,
  });
}

export default async function VideoPage({ params }: Props) {
  const { id } = await params;
  const v = await indexableVideo(id);
  const t = getDict(await getLocale());
  return (
    <>
      {v ? <JsonLd data={videoJsonLd(v, publicEnv.siteUrl, describe(v, t))} /> : null}
      <VideoDetail id={id} />
    </>
  );
}
