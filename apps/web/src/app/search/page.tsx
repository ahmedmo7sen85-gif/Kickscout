import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { Suspense } from 'react';
import { getServerDict } from '@/lib/i18n/server';
import { SearchView } from './SearchView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.search.title, description: t.meta.searchDescription, path: '/search' });
}

export default function SearchPage() {
  return <Suspense><SearchView /></Suspense>;
}
