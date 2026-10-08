import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { ChallengesView } from './ChallengesView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.challenges.title, description: t.challenges.intro };
}

export default function ChallengesPage() {
  return <ChallengesView />;
}
