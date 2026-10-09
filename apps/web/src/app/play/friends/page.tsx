import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';
import { FriendsView } from './FriendsView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.play.friendsTitle, description: t.play.friendsText, path: '/play/friends' });
}

export default function Page() {
  return <FriendsView />;
}
