import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { ScoutDashboard } from './ScoutDashboard';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.scout.title, robots: { index: false } };
}

export default function ScoutPage() {
  return <ScoutDashboard />;
}
