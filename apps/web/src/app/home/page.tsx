import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { FeedView } from './FeedView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.feed.title };
}

export default function HomePage() {
  return <FeedView />;
}
