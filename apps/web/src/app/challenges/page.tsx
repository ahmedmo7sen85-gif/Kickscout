import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { ChallengesView } from './ChallengesView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.challenges.title, description: t.challenges.intro, path: '/challenges' });
}

export default function ChallengesPage() {
  return <ChallengesView />;
}
