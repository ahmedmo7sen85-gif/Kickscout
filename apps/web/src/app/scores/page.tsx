import type { Metadata } from 'next';
import { Suspense } from 'react';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { ScoresView } from './ScoresView';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { t } = await getServerDict();
  // Filtered and dated variants are the same page for search engines: only /scores is indexed.
  const filtered = Object.keys(await searchParams).length > 0;
  return pageMetadata({ t, title: t.football.scoresTitle, description: t.football.scoresDescription, path: '/scores', noindex: filtered });
}

export default function ScoresPage() {
  return <Suspense><ScoresView /></Suspense>;
}
