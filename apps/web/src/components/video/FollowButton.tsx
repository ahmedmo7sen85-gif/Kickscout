'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAuthedAction } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n/provider';

export function FollowButton({ userId, initial = false, size = 'sm', labels, onChange }:
  { userId: string; initial?: boolean; size?: 'sm' | 'md'; labels?: { follow: string; following: string }; onChange?: (on: boolean) => void }) {
  const { t } = useI18n();
  const { me } = useAuth();
  const run = useAuthedAction();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  if (me?.userId === userId) return null;
  const toggle = async () => {
    const next = !on;
    setBusy(true);
    setOn(next);
    const ok = await run(() => api.follow(userId, next));
    if (!ok) setOn(!next); else onChange?.(next);
    setBusy(false);
  };
  return (
    <Button size={size} variant={on ? 'secondary' : 'primary'} aria-pressed={on} disabled={busy} onClick={toggle}>
      {on ? (labels?.following ?? t.feed.followingState) : (labels?.follow ?? t.feed.follow)}
    </Button>
  );
}
