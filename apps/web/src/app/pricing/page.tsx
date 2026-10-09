import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { PricingView } from './PricingView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.billing.pricingTitle, description: t.billing.pricingIntro, path: '/pricing' });
}

export default function PricingPage() {
  return <PricingView />;
}
