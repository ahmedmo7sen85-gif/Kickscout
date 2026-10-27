'use client';

import { useEffect, useState } from 'react';
import { Crest, FollowButton, MatchRow, SourceLine } from '@/components/football/Football';
import { FootballError, OfflineNotice } from '@/components/football/FootballStates';
import { LatestNews } from '@/components/football/News';
import { useFootball } from '@/components/football/useFootball';
import { PageHead, Section } from '@/components/PageHead';
import { SkeletonList } from '@/components/ui/Skeleton';
import { api } from '@/lib/api';
import { browserTimeZone, isInPlay, readTimeZonePref, safeStorage } from '@/lib/football';
import { useI18n } from '@/lib/i18n/provider';

/** A team's recent results and upcoming fixtures, as far as the data source shares them. */
export function TeamView({ id }: { id: string }) {
  const { t, fmt } = useI18n();
  const [tz, setTz] = useState('UTC');
  useEffect(() => { setTz(readTimeZonePref(safeStorage()) ?? browserTimeZone()); }, []);
  const q = useFootball((s) => api.footballTeam(id, s), [id], { refreshMs: 120_000 });

  if (q.loading && !q.data) return <div className="wrap page"><SkeletonList rows={5} label={t.common.loading} /></div>;
  if (q.error && !q.data) return <div className="wrap page"><FootballError error={q.error} onRetry={q.retry} /></div>;
  if (!q.data) return null;
  const { team, matches, source } = q.data;
  const recent = matches.filter((m) => m.status !== 'scheduled' && !isInPlay(m.status)).sort((a, b) => b.kickoff.localeCompare(a.kickoff));
  const live = matches.filter((m) => isInPlay(m.status));
  const upcoming = matches.filter((m) => m.status === 'scheduled').sort((a, b) => a.kickoff.localeCompare(b.kickoff));

  return (
    <div className="wrap wrap--mid page">
      {!q.online ? <OfflineNotice /> : null}
      <PageHead kicker={t.football.teamPage} title={team.name}
        actions={<span className="row"><Crest url={team.logoUrl} size={40} /><FollowButton kind="team" item={team} provider={source.provider} size="md" /></span>} />
      {live.length ? <ul className="match-list">{live.map((m) => <MatchRow key={m.id} m={m} tz={tz} highlight />)}</ul> : null}
      <Section title={t.football.upcomingFixtures} id="upcoming">
        {upcoming.length ? <ul className="match-list">{upcoming.map((m) => <MatchRow key={m.id} m={m} tz={tz} />)}</ul> : <p className="muted">{t.football.noUpcoming}</p>}
      </Section>
      <Section title={t.football.recent} id="recent">
        {recent.length ? <ul className="match-list">{recent.map((m) => <MatchRow key={m.id} m={m} tz={tz} />)}</ul> : <p className="muted">{t.football.noRecent}</p>}
      </Section>
      <SourceLine source={source} />
      <LatestNews q={team.name} title={fmt(t.news.teamNews, { team: team.name })} emptyText={fmt(t.news.noTeamNews, { team: team.name })} />
    </div>
  );
}
