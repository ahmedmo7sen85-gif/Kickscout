import type { Metadata } from 'next';
import { Suspense } from 'react';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { TacticsView } from './TacticsView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.play.tacticsTitle, description: t.play.tacticsText, path: '/play/tactics' });
}

export default function Page() {
  return <Suspense><TacticsView /></Suspense>;
}
