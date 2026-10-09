import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { MyChallengesView } from './MyChallengesView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.challenges.myChallenges, robots: { index: false, follow: false } };
}

export default function MyChallengesPage() {
  return <MyChallengesView />;
}
