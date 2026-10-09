import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { DiscoverView } from './DiscoverView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.discover.title, description: t.discover.intro, path: '/discover' });
}

export default function DiscoverPage() {
  return <DiscoverView />;
}
