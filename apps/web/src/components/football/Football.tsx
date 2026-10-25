'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/lib/errors';
import { useFavorites } from '@/lib/favorites';
import { isInPlay, kickoffTime, relativeTime, scoreText } from '@/lib/football';
import { useI18n } from '@/lib/i18n/provider';
import type { CompetitionRef, FootballSource, MatchStatus, MatchView, TeamRef } from '@/lib/types';

/** Re-renders every `ms` so relative times ("2 minutes ago") stay true. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Where the data came from and how old it is. Shown on every page with provider data. The
 * provider's required attribution is a plain, followed link (no rel="nofollow").
 */
export function SourceLine({ source, compact = false }: { source: FootballSource; compact?: boolean }) {
  const { t, fmt, locale } = useI18n();
  const now = useNow();
  const updated = source.fetchedAt ? fmt(t.football.updated, { time: relativeTime(source.fetchedAt, now, locale) }) : t.football.notUpdated;
  return (
    <div className="stack stack--tight" data-testid="source-line">
      {source.testData ? <p className="notice notice--warn" role="note"><strong>{t.football.testData}</strong></p> : null}
      {source.stale && source.fetchedAt ? (
        <p className="notice notice--warn" role="status" data-testid="stale-notice">
          {fmt(t.football.stale, { time: new Date(source.fetchedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })}
        </p>
      ) : null}
      <p className="source-line small muted">
        <span>{fmt(t.football.source, { name: source.name })}</span>
        <span aria-hidden="true"> · </span>
        <time dateTime={source.fetchedAt ?? undefined}>{updated}</time>
        {!compact && !source.capabilities.realtimeScores ? <><span aria-hidden="true"> · </span><span>{t.football.delayedScores}</span></> : null}
        {source.attribution ? (
          <>
            <span aria-hidden="true"> · </span>
            <a className="link" href={source.attribution.url} target="_blank" rel="noopener" title={t.football.attribution} data-testid="attribution">{source.attribution.text}</a>
          </>
        ) : null}
      </p>
    </div>
  );
}

export function StatusPill({ status, minute, statusText }: { status: MatchStatus; minute?: number | null; statusText?: string | null }) {
  const { t, fmt } = useI18n();
  const live = isInPlay(status);
  const label = status === 'live' && minute != null ? fmt(t.football.minute, { n: minute }) : t.football.status[status];
  return (
    <span className={`status-pill status-pill--${status}`} title={statusText ?? undefined}>
      {live ? <span className="status-pill__dot" aria-hidden="true" /> : null}
      {label}
      {live && status === 'live' && minute != null ? <span className="sr-only"> ({t.football.status.live})</span> : null}
    </span>
  );
}

export function Crest({ url, size = 22 }: { url: string | null; size?: number }) {
  // Provider logos only (https, from the data source); decorative, so empty alt text.
  return url
    ? <img className="crest" src={url} alt="" width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
    : <span className="crest crest--blank" style={{ inlineSize: size, blockSize: size }} aria-hidden="true" />;
}

/** One match in a list: time or state, both teams and the score, linking to the match page. */
export function MatchRow({ m, tz, highlight }: { m: MatchView; tz: string; highlight?: boolean }) {
  const { t, locale } = useI18n();
  const score = scoreText(m);
  const time = kickoffTime(m.kickoff, tz, locale);
  return (
    <li>
      <Link href={`/scores/match/${encodeURIComponent(m.id)}`} className={`match-row${highlight ? ' match-row--fav' : ''}${isInPlay(m.status) ? ' match-row--live' : ''}`} data-testid="match-row">
        <span className="match-row__time">
          {m.status === 'scheduled' ? <time dateTime={m.kickoff}>{time}</time> : <StatusPill status={m.status} minute={m.minute} statusText={m.statusText} />}
        </span>
        <span className="match-row__teams">
          <span className="match-row__team"><Crest url={m.home.logoUrl} /><span className="match-row__name">{m.home.name}</span></span>
          <span className="match-row__team"><Crest url={m.away.logoUrl} /><span className="match-row__name">{m.away.name}</span></span>
        </span>
        <span className="match-row__score" aria-label={score ? `${m.home.name} ${m.score.home}, ${m.away.name} ${m.score.away}` : t.football.kickoff + ' ' + time}>
          {score ? <><b>{m.score.home}</b><b>{m.score.away}</b></> : <span className="muted small">{m.status === 'scheduled' ? '' : '–'}</span>}
        </span>
      </Link>
    </li>
  );
}

/** Follow / unfollow a team or competition (device-local when signed out, saved to the account when signed in). */
export function FollowButton({ kind, item, provider, size = 'sm' }: { kind: 'team' | 'competition'; item: TeamRef | CompetitionRef; provider: string; size?: 'sm' | 'md' }) {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const fav = useFavorites();
  const [busy, setBusy] = useState(false);
  if (!item.id) return null;
  const on = fav.isFollowing(kind, item.id);
  const click = async () => {
    setBusy(true);
    try {
      await fav.toggle(kind, item, provider);
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={`btn btn--${on ? 'primary' : 'secondary'} btn--${size} follow-btn`} aria-pressed={on} disabled={busy || fav.mode === 'loading'} onClick={click}
      aria-label={fmt(on ? t.football.unfollowName : t.football.followName, { name: item.name })} data-testid={`follow-${kind}`}>
      <Icon name="star" size={16} filled={on} />
      {on ? t.football.followingBtn : t.football.follow}
    </button>
  );
}
