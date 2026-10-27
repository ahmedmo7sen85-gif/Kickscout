'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Crest, FollowButton, SourceLine, StatusPill } from '@/components/football/Football';
import { FootballError, OfflineNotice } from '@/components/football/FootballStates';
import { useFootball } from '@/components/football/useFootball';
import { Section } from '@/components/PageHead';
import { SkeletonList } from '@/components/ui/Skeleton';
import { api } from '@/lib/api';
import { browserTimeZone, isInPlay, kickoffDateTime, readTimeZonePref, safeStorage, scoreText } from '@/lib/football';
import { useI18n } from '@/lib/i18n/provider';
import type { MatchDetailView } from '@/lib/types';

function Lineup({ side, m }: { side: 'home' | 'away'; m: MatchDetailView }) {
  const { t, fmt } = useI18n();
  const l = m.lineups![side];
  const team = m[side];
  const list = (players: typeof l.startingXI) => (
    <ol className="lineup__list">
      {players.map((p, i) => (
        <li key={`${p.name}-${i}`}>
          <span className="lineup__num">{p.number ?? ''}</span>
          <span>{p.name}{p.captain ? <abbr title={t.football.captain} className="muted"> (C)</abbr> : null}</span>
          <span className="muted small">{p.position ?? ''}</span>
        </li>
      ))}
    </ol>
  );
  return (
    <div className="card card--outline lineup">
      <h3 className="lineup__team"><Crest url={team.logoUrl} />{team.name}</h3>
      {l.formation ? <p className="small muted">{fmt(t.football.formation, { f: l.formation })}</p> : null}
      <h4 className="kicker">{t.football.startingXI}</h4>
      {list(l.startingXI)}
      {l.substitutes.length ? <><h4 className="kicker">{t.football.substitutes}</h4>{list(l.substitutes)}</> : null}
    </div>
  );
}

export function MatchDetail({ id }: { id: string }) {
  const { t, fmt, locale } = useI18n();
  const [tz, setTz] = useState('UTC');
  useEffect(() => { setTz(readTimeZonePref(safeStorage()) ?? browserTimeZone()); }, []);
  // 30 s while live, 2 minutes before kick-off (so the page notices the start), never once it is over.
  const [phase, setPhase] = useState<'live' | 'before' | 'over'>('before');
  const q = useFootball((s) => api.footballMatch(id, s), [id], { refreshMs: phase === 'live' ? 30_000 : phase === 'before' ? 120_000 : null });
  useEffect(() => {
    if (!q.data) return;
    const st = q.data.match.status;
    setPhase(isInPlay(st) ? 'live' : st === 'scheduled' || st === 'unknown' ? 'before' : 'over');
  }, [q.data]);

  if (q.loading && !q.data) return <div className="wrap page"><SkeletonList rows={5} label={t.common.loading} /></div>;
  if (q.error && !q.data) return <div className="wrap page"><FootballError error={q.error} onRetry={q.retry} /></div>;
  if (!q.data) return null;
  const { match: m, source } = q.data;
  const score = scoreText(m);
  const caps = source.capabilities;
  const teamLink = (side: 'home' | 'away') => {
    const team = m[side];
    return caps.teamMatches ? <Link className="link" href={`/scores/team/${encodeURIComponent(team.id)}`}>{team.name}</Link> : <span>{team.name}</span>;
  };

  return (
    <div className="wrap wrap--mid page">
      {!q.online ? <OfflineNotice /> : null}
      <header className="match-hero card">
        <p className="kicker">
          {m.competition.id && caps.standings
            ? <Link className="link" href={`/scores/competition/${encodeURIComponent(m.competition.id)}`}>{m.competition.name}</Link>
            : m.competition.name}
        </p>
        <h1 className="match-hero__teams">
          <span className="match-hero__side"><Crest url={m.home.logoUrl} size={48} />{teamLink('home')}</span>
          <span className="match-hero__score" aria-live={isInPlay(m.status) ? 'polite' : undefined}>
            {score ? <><b>{m.score.home}</b><span aria-hidden="true">–</span><span className="sr-only"> {t.football.vs} </span><b>{m.score.away}</b></> : <span className="muted">{t.football.vs}</span>}
          </span>
          <span className="match-hero__side"><Crest url={m.away.logoUrl} size={48} />{teamLink('away')}</span>
        </h1>
        <div className="row" style={{ justifyContent: 'center' }}>
          <StatusPill status={m.status} minute={m.minute} statusText={m.statusText} />
          {m.statusText && m.statusText.toLowerCase() !== t.football.status[m.status].toLowerCase() ? <span className="small muted">{m.statusText}</span> : null}
        </div>
        <p className="small muted" style={{ textAlign: 'center' }}>
          {t.football.kickoff}: <time dateTime={m.kickoff}>{kickoffDateTime(m.kickoff, tz, locale)}</time> ({tz})
          {m.halftime && m.halftime.home !== null && m.halftime.away !== null ? <> · {fmt(t.football.htScore, { home: m.halftime.home, away: m.halftime.away })}</> : null}
        </p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <FollowButton kind="team" item={m.home} provider={source.provider} />
          <FollowButton kind="team" item={m.away} provider={source.provider} />
        </div>
      </header>

      <Section title={t.football.events} id="events">
        {m.events === null ? <p className="muted">{t.football.eventsUnavailable}</p>
          : m.events.length === 0 ? <p className="muted">{t.football.noEvents}</p>
          : (
            <ol className="timeline">
              {m.events.map((e, i) => (
                <li key={i} className={`timeline__item timeline__item--${e.side ?? 'none'} timeline__item--${e.type}`}>
                  <span className="timeline__min">{e.minute !== null ? `${e.minute}'` : ''}</span>
                  <span className="timeline__body">
                    <b>{t.football.event[e.type]}</b>
                    {e.player ? <> · {e.player}</> : null}
                    {e.side ? <span className="muted small"> ({m[e.side].name})</span> : null}
                    {e.score ? <span className="muted small"> {e.score.home}–{e.score.away}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          )}
      </Section>

      <Section title={t.football.lineups} id="lineups">
        {m.lineups === null ? <p className="muted">{caps.lineups ? t.football.lineupsUnavailable : t.football.lineupsUnavailable}</p> : (
          <>
            {!m.lineups.confirmed ? <p className="notice" role="note"><span>{t.football.lineupsUnconfirmed}</span></p> : null}
            <div className="lineups"><Lineup side="home" m={m} /><Lineup side="away" m={m} /></div>
          </>
        )}
      </Section>

      <Section title={t.football.stats} id="stats">
        {m.stats === null ? <p className="muted">{t.football.statsUnavailable}</p> : (
          <table className="stats-table">
            <thead><tr><th scope="col">{m.home.name}</th><th scope="col"><span className="sr-only">{t.football.stats}</span></th><th scope="col">{m.away.name}</th></tr></thead>
            <tbody>{m.stats.map((s) => <tr key={s.label}><td>{s.home ?? '–'}</td><th scope="row">{s.label}</th><td>{s.away ?? '–'}</td></tr>)}</tbody>
          </table>
        )}
      </Section>

      {m.sourceUrl ? <p className="small"><a className="link" href={m.sourceUrl} target="_blank" rel="noopener">{fmt(t.football.viewAtSource, { name: source.name })}</a></p> : null}
      {isInPlay(m.status) ? <p className="small muted">{t.football.liveRefresh}</p> : null}
      <SourceLine source={source} />
    </div>
  );
}
