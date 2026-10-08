import type { Metadata } from 'next';
import { ProfileView } from './ProfileView';

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const h = decodeURIComponent(handle);
  return { title: `@${h}`, openGraph: { title: `@${h} · KICKSCOUT`, type: 'profile', url: `/u/${encodeURIComponent(h)}` } };
}

export default async function ProfilePage({ params }: Props) {
  const { handle } = await params;
  return <ProfileView handle={decodeURIComponent(handle)} />;
}
