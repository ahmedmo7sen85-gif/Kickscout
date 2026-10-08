import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { RadarView } from './RadarView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.radar.title, description: t.radar.intro };
}

export default function RadarPage() {
  return <RadarView />;
}
