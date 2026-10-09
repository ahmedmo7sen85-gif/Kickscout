'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { PageHead, Section } from '@/components/PageHead';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import type { ChallengeView, HeadToHeadView } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { formatScore, SubmissionRow } from '../[slug]/ChallengeDetail';

/** A player's own challenge activity: what they joined, every entry and its state, badges, bests, head-to-heads, appeals. */
export function MyChallengesView() {
  const { t } = useI18n();
  return (
    <div className="wrap wrap--mid page">
      <PageHead title={t.challenges.myChallenges} intro={t.challenges.myIntro} actions={<ButtonLink href="/challenges">{t.challenges.browse}</ButtonLink>} />
      <AuthGate><Mine /></AuthGate>
    </div>
  );
}

function Mine() {
  const { t, fmt, pick, formatDate, formatNumber } = useI18n();
  const d = useApi((s) => api.myChallenges(s), []);
  const [h2hFor, setH2hFor] = useState<ChallengeView | null>(null);
  if (d.status === 'loading') return <SkeletonList rows={5} label={t.common.loading} />;
  if (d.status === 'error') return <ErrorState error={d.error} title={t.challenges.errorTitle} onRetry={d.retry} />;
  const m = d.data;
  const nothing = !m.active.length && !m.submissions.length && !m.badges.length;

  return (
    <div className="stack stack--loose">
      <div className="row">
        <span className="badge badge--green">{fmt(t.challenges.xp, { n: formatNumber(m.challengeXp) })}</span>
        {m.streakWeeks > 0 ? <span className="badge badge--outline">{fmt(t.challenges.streak, { n: m.streakWeeks })}</span> : null}
      </div>
      {nothing ? <EmptyState icon="trophy" title={t.challenges.nothingYet} action={<ButtonLink href="/challenges" variant="primary">{t.challenges.browse}</ButtonLink>} /> : null}

      {m.active.length ? (
        <Section title={t.challenges.myActive} id="my-active">
          <ul className="list">
            {m.active.map((a) => (
              <li key={a.challenge.id} className="list__row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
                <div className="stack stack--tight" style={{ flex: 1, minInlineSize: '12rem' }}>
                  <Link className="link" href={`/challenges/${a.challenge.slug}`}>{pick(a.challenge.title)}</Link>
                  <span className="small muted">
                    {t.challenges.phases[a.challenge.phase]} · {fmt(t.challenges.attempts, { used: a.attemptsUsed, limit: a.attemptsUsed + a.attemptsLeft })}
                    {a.challenge.phase === 'open' ? ` · ${fmt(t.challenges.endsOn, { date: formatDate(a.challenge.endsAt) })}` : ''}
                  </span>
                  {a.best ? <strong>{formatScore(a.best.value, a.best.unit, t, formatNumber)}</strong> : null}
                </div>
                {a.challenge.phase === 'open' ? <Button size="sm" variant="ghost" onClick={() => setH2hFor(a.challenge)}>{t.challenges.h2hInvite}</Button> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {m.headToHeads.length ? (
        <Section title={t.challenges.headToHeads} id="my-h2h">
          <ul className="list">{m.headToHeads.map((h) => <HeadToHeadRow key={h.id} h={h} onChange={d.retry} />)}</ul>
        </Section>
      ) : null}

      {m.submissions.length ? (
        <Section title={t.challenges.yourEntries} id="my-entries">
          <ul className="list">{m.submissions.map((s) => <SubmissionRow key={s.id} s={s} onChange={d.retry} showChallenge />)}</ul>
        </Section>
      ) : null}

      {m.personalBests.length ? (
        <Section title={t.challenges.personalBests} id="my-bests">
          <ul className="list">
            {m.personalBests.map((b) => (
              <li key={b.templateKey} className="list__row">
                <span dir="auto">{pick(b.title)}</span>
                <strong>{formatScore(b.value, b.unit, t, formatNumber)}</strong>
                <Link className="small link" href={`/challenges/${b.challenge.slug}`}>{formatDate(b.at)}</Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {m.badges.length ? (
        <Section title={t.challenges.badges} id="my-badges">
          <div className="grid-players">
            {m.badges.map((b) => (
              <div key={`${b.key}-${b.awardedAt}`} className="card card--outline stack stack--tight">
                <strong dir="auto">{pick(b.name)}</strong>
                <span className="small muted" dir="auto">{pick(b.description)}</span>
                <time className="small muted" dateTime={b.awardedAt}>{formatDate(b.awardedAt)}</time>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {m.appeals.length ? (
        <Section title={t.challenges.appeals} id="my-appeals">
          <ul className="list">
            {m.appeals.map((a) => (
              <li key={a.id} className="list__row" style={{ flexWrap: 'wrap' }}>
                <Link className="link" href={`/challenges/${a.challenge.slug}`}>{pick(a.challenge.title)}</Link>
                <span className="badge badge--outline">{t.challenges.appealStatus[a.status]}</span>
                {a.resolution ? <span className="small muted" dir="auto">{a.resolution}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {h2hFor ? <HeadToHeadInvite c={h2hFor} onClose={() => setH2hFor(null)} onDone={() => { setH2hFor(null); d.retry(); }} /> : null}
    </div>
  );
}

function HeadToHeadRow({ h, onChange }: { h: HeadToHeadView; onChange: () => void }) {
  const { t, fmt, pick } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const respond = async (accept: boolean) => {
    setBusy(true);
    try { await api.respondHeadToHead(h.id, accept); onChange(); } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <li className="list__row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
      <div className="stack stack--tight" style={{ flex: 1, minInlineSize: '12rem' }}>
        <Link className="link" href={`/challenges/${h.challenge.slug}`}>{pick(h.challenge.title)}</Link>
        <span className="small" dir="auto">{fmt(t.challenges.versus, { name: h.other.displayName })}</span>
      </div>
      <span className="badge badge--outline">{h.result ? t.challenges.h2hResult[h.result] : t.challenges.h2hStatus[h.status]}</span>
      {h.role === 'opponent' && h.status === 'pending' ? (
        <span className="row">
          <Button size="sm" variant="primary" loading={busy} onClick={() => respond(true)}>{t.challenges.accept}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => respond(false)}>{t.challenges.decline}</Button>
        </span>
      ) : null}
    </li>
  );
}

/** Head-to-heads are only between mutual followers (the API checks), so the picker lists friends. */
function HeadToHeadInvite({ c, onClose, onDone }: { c: ChallengeView; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const friends = useApi((s) => api.playFriends(s), []);
  const [busy, setBusy] = useState<string | null>(null);
  const invite = async (userId: string) => {
    setBusy(userId);
    try {
      await api.createHeadToHead(c.slug, userId);
      toast.show(t.challenges.h2hSent, { tone: 'success' });
      onDone();
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  return (
    <Sheet open onClose={onClose} title={t.challenges.h2hInvite}>
      {friends.status === 'loading' ? <SkeletonList rows={3} label={t.common.loading} /> : null}
      {friends.status === 'error' ? <ErrorState error={friends.error} onRetry={friends.retry} /> : null}
      {friends.status === 'success' && !friends.data.items.length ? <p className="muted">{t.challenges.h2hNoFriends}</p> : null}
      {friends.status === 'success' && friends.data.items.length ? (
        <ul className="list">
          {friends.data.items.map((f) => (
            <li key={f.userId} className="list__row">
              <span dir="auto">{f.displayName} <span className="muted small">@{f.handle}</span></span>
              <Button size="sm" variant="primary" loading={busy === f.userId} disabled={busy !== null} onClick={() => invite(f.userId)}>{t.challenges.h2hInvite}</Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Sheet>
  );
}
