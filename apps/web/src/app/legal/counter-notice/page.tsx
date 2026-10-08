import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getServerDict } from '@/lib/i18n/server';
import { CounterNoticeForm } from './CounterNoticeForm';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.legal.counterTitle, robots: { index: false } };
}

export default function Page() {
  return <Suspense><CounterNoticeForm /></Suspense>;
}
