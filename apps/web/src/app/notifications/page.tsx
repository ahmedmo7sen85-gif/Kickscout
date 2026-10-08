import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { NotificationsView } from './NotificationsView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.notifications.title, robots: { index: false } };
}

export default function NotificationsPage() {
  return <NotificationsView />;
}
