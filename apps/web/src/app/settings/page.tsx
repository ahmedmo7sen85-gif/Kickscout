import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { SettingsView } from './SettingsView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.settings.title, robots: { index: false } };
}

export default function SettingsPage() {
  return <SettingsView />;
}
