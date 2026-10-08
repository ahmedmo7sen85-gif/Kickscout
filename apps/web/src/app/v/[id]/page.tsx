import type { Metadata } from 'next';
import { getDict } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import { fetchPublicVideo } from '@/lib/server-api';
import { VideoDetail } from './VideoDetail';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const t = getDict(await getLocale());
  const v = await fetchPublicVideo(id);
  if (!v || v.status !== 'published' || v.visibility !== 'public') {
    return { title: t.meta.title, description: t.meta.description, robots: { index: false } };
  }
  const skill = v.skill ? t.skills[v.skill] : null;
  const title = `${v.title} · @${v.owner.handle}`;
  const description = v.description || [skill, ...v.hashtags.map((h) => `#${h}`)].filter(Boolean).join(' · ') || t.meta.description;
  return {
    title,
    description,
    alternates: { canonical: `/v/${v.id}` },
    openGraph: {
      type: 'video.other',
      title,
      description,
      url: `/v/${v.id}`,
      images: v.thumbnailUrl ? [{ url: v.thumbnailUrl, width: 720, height: 1280, alt: v.title }] : undefined,
      videos: v.playbackUrl ? [{ url: v.playbackUrl, width: 720, height: 1280 }] : undefined,
    },
    twitter: { card: v.thumbnailUrl ? 'summary_large_image' : 'summary', title, description, images: v.thumbnailUrl ? [v.thumbnailUrl] : undefined },
  };
}

export default async function VideoPage({ params }: Props) {
  const { id } = await params;
  return <VideoDetail id={id} />;
}
