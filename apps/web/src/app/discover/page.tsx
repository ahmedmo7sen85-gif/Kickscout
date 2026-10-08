import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { DiscoverView } from './DiscoverView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.discover.title, description: t.discover.intro };
}

export default function DiscoverPage() {
  return <DiscoverView />;
}
