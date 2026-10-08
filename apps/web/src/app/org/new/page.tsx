import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { OrgNewView } from './OrgNewView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.org.newTitle, robots: { index: false } };
}

export default function Page() {
  return <OrgNewView />;
}
