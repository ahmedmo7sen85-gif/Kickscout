'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { PageHead, Section } from '@/components/PageHead';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { PlayChallengeView } from '@/lib/types';

export function FriendsView() {
  const { t } = useI18n();
  return (
    <div className="wrap wrap--mid page">
      <div className="row">
        <Link href="/play" className="back-link"><Icon name="arrow" size={16} className="back-link__icon" />{t.play.backToPlay}</Link>
      </div>
      <PageHead title={t.play.friendsTitle} intro={t.play.friendsIntro} />
      <p className="notice play-note"><Icon name="shield" size={18} /><span>{t.play.safety}</span></p>
      <AuthGate><Friends /></AuthGate>
    </div>
  );
}

function Friends() {
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const list = useApi((s) => api.playChallenges(s), []);
  const friends = useApi((s) => api.playFriends(s), []);
  const [busy, setBusy] = useState<string | null>(null);

  const challenge = async (userId: string) => {
    setBusy(userId);
    try {
      const c = await api.createPlayChallenge(userId);
      toast.show(t.play.challengeCreated, { tone: 'success' });
      router.push(`/play/tactics?challenge=${c.id}`);
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
      setBusy(null);
    }
  };
  const decline = async (id: string) => {
    setBusy(id);
    try {
      await api.declinePlayChallenge(id);
      list.setData((d) => ({ ...d, items: d.items.map((c) => (c.id === id ? { ...c, status: 'declined' as const } : c)) }));
      toast.show(t.play.declined);
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack stack--loose">
      <Section title={t.play.challengesTitle} id="play-challenges">
        {list.status === 'loading' ? <SkeletonList rows={2} label={t.common.loading} /> : null}
        {list.status === 'error' ? <ErrorState error={list.error} onRetry={list.retry} /> : null}
        {list.status === 'success' && !list.data.items.length ? <p className="muted">{t.play.noChallenges}</p> : null}
        {list.status === 'success' ? (
          <ul className="challenge-list">
            {list.data.items.map((c) => <ChallengeRow key={c.id} c={c} busy={busy === c.id} onDecline={() => void decline(c.id)} />)}
          </ul>
        ) : null}
      </Section>

      <Section title={t.play.friendsListTitle} id="play-friends">
        {friends.status === 'loading' ? <SkeletonList rows={3} label={t.common.loading} /> : null}
        {friends.status === 'error' ? <ErrorState error={friends.error} onRetry={friends.retry} /> : null}
        {friends.status === 'success' && !friends.data.items.length ? <EmptyState icon="user" title={t.play.friendsListTitle} text={t.play.noFriends} /> : null}
        {friends.status === 'success' && friends.data.items.length ? (
          <ul className="friend-list">
            {friends.data.items.map((f) => (
              <li key={f.userId} className="friend">
                <span className="stack stack--tight">
                  <strong>{f.displayName}</strong>
                  <Link href={`/u/${f.handle}`} className="muted" dir="ltr">@{f.handle}</Link>
                </span>
                <Button variant="primary" size="sm" onClick={() => void challenge(f.userId)} loading={busy === f.userId} disabled={Boolean(busy)}>{t.play.challenge}</Button>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}

function ChallengeRow({ c, busy, onDecline }: { c: PlayChallengeView; busy: boolean; onDecline: () => void }) {
  const { t, fmt, formatDate } = useI18n();
  const open = c.status === 'pending' || c.status === 'accepted';
  const myTurn = open && !c.myFinished;
  const status = c.status === 'completed'
    ? c.result === 'won' ? t.play.statusWon : c.result === 'lost' ? fmt(t.play.statusLost, { name: c.other.displayName }) : t.play.statusDraw
    : c.status === 'declined' ? t.play.statusDeclined
      : c.status === 'expired' ? t.play.statusExpired
        : myTurn ? t.play.statusYourTurn : fmt(t.play.statusWaiting, { name: c.other.displayName });
  const tone = c.result === 'won' ? 'green' : myTurn ? 'green' : 'outline';
  return (
    <li className="challenge">
      <div className="stack stack--tight">
        <strong>{fmt(t.play.vs, { name: c.other.displayName })}</strong>
        <span className="row muted challenge__meta">
          {c.myPoints !== null && c.theirPoints !== null ? <span dir="ltr">{fmt(t.play.scoreLine, { mine: c.myPoints, theirs: c.theirPoints })}</span> : null}
          {open ? <span>{fmt(t.play.ends, { date: formatDate(c.expiresAt) })}</span> : null}
        </span>
      </div>
      <div className="row">
        <span className={`badge badge--${tone}`}>{status}</span>
        {myTurn ? <ButtonLink href={`/play/tactics?challenge=${c.id}`} variant="primary" size="sm">{t.play.playYourRound}</ButtonLink> : null}
        {myTurn && c.role === 'opponent' && c.status === 'pending' && !c.myRoundId
          ? <Button variant="ghost" size="sm" onClick={onDecline} loading={busy}>{t.play.decline}</Button> : null}
      </div>
    </li>
  );
}

