import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { TakedownForm } from './TakedownForm';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.legal.takedownTitle, description: t.legal.takedownIntro };
}

export default function Page() {
  return <TakedownForm />;
}
