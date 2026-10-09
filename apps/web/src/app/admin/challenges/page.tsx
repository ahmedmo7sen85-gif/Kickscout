import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { ChallengeAdminView } from './ChallengeAdminView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.challenges.adminTitle, robots: { index: false, follow: false } };
}

export default function AdminChallengesPage() {
  return <ChallengeAdminView />;
}
