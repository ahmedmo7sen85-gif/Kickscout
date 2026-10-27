import type { Metadata } from 'next';
import { Suspense } from 'react';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { NewsView } from './NewsView';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { t } = await getServerDict();
  // Filtered variants are the same page for search engines: only /news is indexed.
  const filtered = Object.keys(await searchParams).length > 0;
  return pageMetadata({ t, title: t.news.title, description: t.news.description, path: '/news', noindex: filtered });
}

export default function NewsPage() {
  return <Suspense><NewsView /></Suspense>;
}
