import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getServerDict } from '@/lib/i18n/server';
import { UploadFlow } from './UploadFlow';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.upload.title, robots: { index: false } };
}

export default function UploadPage() {
  return <Suspense><UploadFlow /></Suspense>;
}
