import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { FollowingView } from './FollowingView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.football.followingTitle, robots: { index: false } };
}

export default function FollowingPage() {
  return <FollowingView />;
}
