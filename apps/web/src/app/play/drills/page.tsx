import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { DrillsView } from './DrillsView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.play.drillsTitle, description: t.play.drillsText, path: '/play/drills' });
}

export default function Page() {
  return <DrillsView />;
}
