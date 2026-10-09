'use client';

import Link from 'next/link';
import { AuthGate } from '@/components/AuthGate';
import { PageHead } from '@/components/PageHead';
import { XpCard } from '@/components/play/XpCard';
import { Icon, type IconName } from '@/components/ui/Icon';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/States';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';

export function PlayHub() {
  const { t } = useI18n();
  return (
    <div className="wrap wrap--mid page">
      <PageHead title={t.play.title} intro={t.play.intro} />
      <AuthGate><Hub /></AuthGate>
    </div>
  );
}

function Hub() {
  const { t, fmt } = useI18n();
  const me = useApi((s) => api.playMe(s), []);
  const ch = useApi((s) => api.playChallenges(s), []);
  const waiting = ch.status === 'success' ? ch.data.items.filter((c) => c.status === 'pending' && c.role === 'opponent' && !c.myRoundId).length : 0;

  const modes: { href: string; icon: IconName; title: string; text: string; note?: string }[] = [
    { href: '/play/tactics', icon: 'clipboard', title: t.play.tacticsTitle, text: t.play.tacticsText,
      note: me.status === 'success' ? fmt(t.play.roundsLeft, { n: me.data.today.roundsLeft }) : undefined },
    { href: '/play/scan', icon: 'scout', title: t.play.scanTitle, text: t.play.scanText },
    { href: '/play/drills', icon: 'trophy', title: t.play.drillsTitle, text: t.play.drillsText },
    { href: '/play/friends', icon: 'user', title: t.play.friendsTitle, text: t.play.friendsText,
      note: waiting ? fmt(t.play.invitesWaiting, { n: waiting }) : undefined },
  ];

  return (
    <div className="stack stack--loose">
      {me.status === 'loading' ? <SkeletonList rows={1} label={t.common.loading} /> : null}
      {me.status === 'error' ? <ErrorState error={me.error} title={t.play.loadError} onRetry={me.retry} /> : null}
      {me.status === 'success' ? <XpCard profile={me.data} /> : null}
      <div className="play-modes">
        {modes.map((m) => (
          <Link key={m.href} href={m.href} className="play-mode">
            <span className="play-mode__icon"><Icon name={m.icon} /></span>
            <span className="play-mode__title">{m.title}</span>
            <span className="play-mode__text">{m.text}</span>
            {m.note ? <span className="badge badge--green play-mode__note">{m.note}</span> : null}
          </Link>
        ))}
      </div>
      <p className="muted play-note"><Icon name="shield" size={16} /> {t.play.xpPrivate}</p>
    </div>
  );
}
