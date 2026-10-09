import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { FeedView } from './FeedView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.feed.title, description: t.meta.feedDescription, path: '/home' });
}

export default function HomePage() {
  return <FeedView />;
}
