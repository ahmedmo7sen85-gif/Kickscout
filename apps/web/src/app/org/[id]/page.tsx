import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { OrgView } from './OrgView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.org.dashboard, robots: { index: false } };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrgView id={id} />;
}
