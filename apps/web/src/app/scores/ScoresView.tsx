'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { FollowButton, MatchRow, SourceLine, Crest } from '@/components/football/Football';
import { FootballError, OfflineNotice } from '@/components/football/FootballStates';
import { LatestNews } from '@/components/football/News';
import { useFootball } from '@/components/football/useFootball';
import { PageHead } from '@/components/PageHead';
import { Icon } from '@/components/ui/Icon';
import { SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/States';
import { Tabs } from '@/components/ui/Tabs';
import { api } from '@/lib/api';
import { useFavorites } from '@/lib/favorites';
import {
  browserTimeZone, dayInZone, dayLabel, groupByCompetition, involves, isDay, isInPlay, readTimeZonePref, safeStorage, shiftDay, writeTimeZonePref,
} from '@/lib/football';
import { useI18n } from '@/lib/i18n/provider';
import type { MatchView } from '@/lib/types';

type Filter = 'all' | 'live' | 'upcoming' | 'finished';
const FILTERS: Filter[] = ['all', 'live', 'upcoming', 'finished'];

const matchesFilter = (m: MatchView, f: Filter) =>
  f === 'all' || (f === 'live' ? isInPlay(m.status) : f === 'upcoming' ? m.status === 'scheduled' : m.status === 'finished');

function zones(current: string): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    all = [];
  }
  return [...new Set([current, 'UTC', ...all])];
}

export function ScoresView() {
  const { t, fmt, locale } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const fav = useFavorites();

  // The zone is only known in the browser; nothing loads until it is (no server/client mismatch).
  const [tz, setTz] = useState<string | null>(null);
  useEffect(() => { setTz(readTimeZonePref(safeStorage()) ?? browserTimeZone()); }, []);
  const today = tz ? dayInZone(new Date(), tz) : null;
  const day = isDay(params.get('date')) ? params.get('date')! : today;
  const filter = (FILTERS as string[]).includes(params.get('status') ?? '') ? (params.get('status') as Filter) : 'all';
  const competition = params.get('competition') ?? '';

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) if (v) next.set(k, v); else next.delete(k);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Poll every 30 s while something is live (the server cache and the provider update about once a
  // minute, so faster polling would only repeat the same answer), every 2 minutes otherwise.
  const [liveNow, setLiveNow] = useState(false);
  const q = useFootball((signal) => api.footballMatches({ date: day ?? undefined, tz: tz ?? undefined }, signal), [day, tz], {
    enabled: Boolean(tz && day),
    refreshMs: liveNow ? 30_000 : 120_000,
  });
  const anyLive = q.data?.matches.some((m) => isInPlay(m.status)) ?? false;
  useEffect(() => { setLiveNow(anyLive); }, [anyLive]);

  const shown = useMemo(() => (q.data?.matches ?? []).filter((m) => matchesFilter(m, filter) && (!competition || m.competition.id === competition)), [q.data, filter, competition]);
  const mine = shown.filter((m) => involves(m, fav.teamIds, fav.competitionIds));
  const groups = groupByCompetition(shown);
  const counts = Object.fromEntries(FILTERS.map((f) => [f, (q.data?.matches ?? []).filter((m) => matchesFilter(m, f)).length])) as Record<Filter, number>;
  const provider = q.data?.source.provider ?? '';

  return (
    <div className="wrap page">
      <PageHead title={t.football.scoresTitle} intro={t.football.scoresIntro}
        actions={<span className="row">
          <Link href="/news" className="btn btn--secondary btn--sm">{t.nav.news}</Link>
          <Link href="/following" className="btn btn--secondary btn--sm"><Icon name="star" size={16} />{t.nav.following}</Link>
        </span>} />

      <div className="scores-toolbar">
        <div className="day-nav" role="group" aria-label={t.football.pickDate}>
          <button type="button" className="icon-btn day-nav__prev" onClick={() => day && setParam({ date: shiftDay(day, -1) })} aria-label={t.football.prevDay} disabled={!day}>
            <Icon name="arrow" size={18} />
          </button>
          <label className="day-nav__date">
            <span className="sr-only">{t.football.pickDate}</span>
            <input className="input input--sm" type="date" value={day ?? ''} onChange={(e) => isDay(e.target.value) && setParam({ date: e.target.value })} />
          </label>
          <button type="button" className="icon-btn day-nav__next" onClick={() => day && setParam({ date: shiftDay(day, 1) })} aria-label={t.football.nextDay} disabled={!day}>
            <Icon name="arrow" size={18} />
          </button>
          {day && today && day !== today ? <button type="button" className="btn btn--ghost btn--sm" onClick={() => setParam({ date: null })}>{t.football.today}</button> : null}
        </div>
        {tz ? (
          <label className="tz-pick small">
            <span className="muted">{t.football.timeZone}</span>
            <select className="input input--sm" value={tz} onChange={(e) => {
              const v = e.target.value;
              setTz(v);
              writeTimeZonePref(safeStorage(), v === browserTimeZone() ? null : v);
            }}>
              {zones(tz).map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      {day ? <h2 className="section-title" aria-live="polite">{dayLabel(day, locale)}</h2> : null}
      {tz ? <p className="small muted">{fmt(t.football.timesIn, { tz })}</p> : null}

      {!q.online ? <OfflineNotice /> : null}

      <Tabs<Filter> label={t.football.filterLabel} active={filter} onChange={(f) => setParam({ status: f === 'all' ? null : f })}
        items={FILTERS.map((f) => ({ id: f, label: t.football[f], extra: q.data ? <span className="chip__count"> {counts[f]}</span> : null }))} />

      {q.data && q.data.competitions.length > 1 ? (
        <div className="chips" role="group" aria-label={t.football.competitionsLabel}>
          <button type="button" className={`chip chip--sm${competition ? '' : ' is-active'}`} aria-pressed={!competition} onClick={() => setParam({ competition: null })}>{t.football.allCompetitions}</button>
          {q.data.competitions.filter((c) => c.id).map((c) => (
            <button key={c.id} type="button" className={`chip chip--sm${competition === c.id ? ' is-active' : ''}`} aria-pressed={competition === c.id}
              onClick={() => setParam({ competition: competition === c.id ? null : c.id })}>{c.name}</button>
          ))}
        </div>
      ) : null}

      {q.data?.coverage === 'recent-window' ? <p className="notice" role="note"><span>{t.football.recentWindowNote}</span></p> : null}

      {q.loading && !q.data ? <SkeletonList rows={6} label={t.football.loading} />
        : q.error && !q.data ? <FootballError error={q.error} onRetry={q.retry} />
        : q.data ? (
          <div className="stack stack--loose" id="matches">
            {mine.length ? (
              <section className="match-group match-group--fav" aria-labelledby="your-teams">
                <h2 className="match-group__title" id="your-teams"><Icon name="star" size={16} filled /> {t.football.yourTeams}</h2>
                <ul className="match-list">{mine.map((m) => <MatchRow key={`fav-${m.id}`} m={m} tz={tz!} highlight />)}</ul>
              </section>
            ) : null}
            {groups.length ? groups.map((g) => (
              <section key={g.key} className="match-group" aria-label={g.competition.name}>
                <div className="match-group__head">
                  <h2 className="match-group__title">
                    <Crest url={g.competition.logoUrl} size={20} />
                    {g.competition.id && q.data!.source.capabilities.standings
                      ? <Link href={`/scores/competition/${encodeURIComponent(g.competition.id)}`} className="link">{g.competition.name}</Link>
                      : <span>{g.competition.name}</span>}
                    {g.competition.area ? <span className="muted small"> · {g.competition.area}</span> : null}
                  </h2>
                  <FollowButton kind="competition" item={g.competition} provider={provider} />
                </div>
                <ul className="match-list">{g.matches.map((m) => <MatchRow key={m.id} m={m} tz={tz!} highlight={involves(m, fav.teamIds, fav.competitionIds)} />)}</ul>
              </section>
            )) : (
              <EmptyState icon="ball" title={t.football.emptyTitle}
                text={q.data.matches.length ? t.football.emptyFiltered : fmt(t.football.emptyText, { source: q.data.source.name })} />
            )}
            {anyLive ? <p className="small muted">{t.football.liveRefresh}</p> : null}
            <SourceLine source={q.data.source} />
          </div>
        ) : null}

      <LatestNews />
    </div>
  );
}
