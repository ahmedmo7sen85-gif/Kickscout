import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { MetricsView } from './MetricsView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.metrics.title, robots: { index: false, follow: false } };
}

export default function AdminMetricsPage() {
  return <MetricsView />;
}
