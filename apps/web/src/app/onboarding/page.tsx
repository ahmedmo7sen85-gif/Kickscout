import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { OnboardingForm } from './OnboardingForm';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.onboarding.title, robots: { index: false } };
}

export default function OnboardingPage() {
  return <OnboardingForm />;
}
