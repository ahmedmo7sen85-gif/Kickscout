import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getServerDict } from '@/lib/i18n/server';
import { SearchView } from './SearchView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.search.title };
}

export default function SearchPage() {
  return <Suspense><SearchView /></Suspense>;
}
