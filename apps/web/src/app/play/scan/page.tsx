import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { ScanView } from './ScanView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.play.scanTitle, description: t.play.scanText, path: '/play/scan' });
}

export default function Page() {
  return <ScanView />;
}
