import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getServerDict } from '@/lib/i18n/server';
import { PipelineView } from './PipelineView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.pipeline.title, robots: { index: false } };
}

export default function Page() {
  return <div className="wrap page"><Suspense><PipelineView /></Suspense></div>;
}
