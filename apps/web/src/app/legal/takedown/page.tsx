import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { TakedownForm } from './TakedownForm';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.legal.takedownTitle, description: t.legal.takedownIntro, path: '/legal/takedown' });
}

export default function Page() {
  return <TakedownForm />;
}
