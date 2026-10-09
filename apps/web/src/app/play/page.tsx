import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { PlayHub } from './PlayHub';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.play.title, description: t.play.intro, path: '/play' });
}

export default function PlayPage() {
  return <PlayHub />;
}
