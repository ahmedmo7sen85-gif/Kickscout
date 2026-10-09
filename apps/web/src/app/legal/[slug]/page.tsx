import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { notFound } from 'next/navigation';
import { LegalPage } from '@/components/legal/LegalPage';
import { LEGAL_DOCS, legalDoc } from '@/lib/legal';
import { getServerDict } from '@/lib/i18n/server';

export function generateStaticParams() {
  return LEGAL_DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const doc = legalDoc((await params).slug);
  if (!doc) return {};
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.legal[doc.titleKey], description: doc.summary, path: `/legal/${doc.slug}` });
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const doc = legalDoc((await params).slug);
  if (!doc) notFound();
  const { t, locale } = await getServerDict();
  return <LegalPage doc={doc} t={t} locale={locale} />;
}
