import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { RadarView } from './RadarView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.radar.title, description: t.radar.intro, path: '/radar' });
}

export default function RadarPage() {
  return <RadarView />;
}
