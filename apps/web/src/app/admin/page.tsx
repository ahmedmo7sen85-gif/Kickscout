import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { AdminView } from './AdminView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.admin.title, robots: { index: false, follow: false } };
}

export default function AdminPage() {
  return <AdminView />;
}
