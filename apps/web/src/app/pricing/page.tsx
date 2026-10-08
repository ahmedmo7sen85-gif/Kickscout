import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { PricingView } from './PricingView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.billing.pricingTitle, description: t.billing.pricingIntro };
}

export default function PricingPage() {
  return <PricingView />;
}
