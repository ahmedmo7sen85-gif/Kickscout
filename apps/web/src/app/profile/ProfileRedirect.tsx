'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { useAuth } from '@/lib/auth';

/** `/profile` sends you to your own public profile. */
export function ProfileRedirect() {
  const { me } = useAuth();
  const router = useRouter();
  useEffect(() => { if (me) router.replace(`/u/${me.profile.handle}`); }, [me, router]);
  return <AuthGate>{null}</AuthGate>;
}
