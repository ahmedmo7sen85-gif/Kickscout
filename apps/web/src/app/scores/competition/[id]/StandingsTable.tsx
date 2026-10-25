'use client';

import Link from 'next/link';
import { Crest, FollowButton, SourceLine } from '@/components/football/Football';
import { FootballError, OfflineNotice } from '@/components/football/FootballStates';
import { useFootball } from '@/components/football/useFootball';
import { PageHead } from '@/components/PageHead';
import { SkeletonList } from '@/components/ui/Skeleton';
import { api } from '@/lib/api';
import { useFavorites } from '@/lib/favorites';
import { useI18n } from '@/lib/i18n/provider';

/** A competition's table. Short column headings carry their full name for screen readers. */
export function StandingsTable({ id }: { id: string }) {
  const { t, fmt } = useI18n();
  const fav = useFavorites();
  const q = useFootball((s) => api.footballStandings(id, s), [id], { refreshMs: 300_000 });

  if (q.loading && !q.data) return <div className="wrap page"><SkeletonList rows={8} label={t.common.loading} /></div>;
  if (q.error && !q.data) return <div className="wrap page"><FootballError error={q.error} onRetry={q.retry} /></div>;
  if (!q.data) return null;
  const { competition, season, groups, source } = q.data;
  const tt = t.football.table;
  const col = (short: string, long: string) => <th scope="col"><abbr title={long}>{short}</abbr></th>;

  return (
    <div className="wrap wrap--mid page">
      {!q.online ? <OfflineNotice /> : null}
      <PageHead kicker={t.football.standings} title={competition.name} intro={season ? fmt(t.football.season, { s: season }) : undefined}
        actions={<span className="row"><Crest url={competition.logoUrl} size={40} /><FollowButton kind="competition" item={competition} provider={source.provider} size="md" /></span>} />
      {groups.map((g, gi) => (
        <section key={g.name ?? gi} className="stack" aria-label={g.name ?? competition.name}>
          {g.name ? <h2 className="section-title">{g.name}</h2> : null}
          <div className="table-scroll">
            <table className="standings">
              <thead>
                <tr>
                  {col(tt.pos, tt.pos)}
                  <th scope="col" className="standings__team">{tt.team}</th>
                  {col(tt.played, tt.playedLong)}{col(tt.won, tt.wonLong)}{col(tt.drawn, tt.drawnLong)}{col(tt.lost, tt.lostLong)}
                  {col(tt.gd, tt.gdLong)}{col(tt.points, tt.pointsLong)}
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.team.id} className={fav.teamIds.has(r.team.id) ? 'is-fav' : undefined}>
                    <td>{r.position}</td>
                    <th scope="row" className="standings__team">
                      <Link className="link" href={`/scores/team/${encodeURIComponent(r.team.id)}`}><Crest url={r.team.logoUrl} size={18} />{r.team.name}</Link>
                    </th>
                    <td>{r.played}</td><td>{r.won}</td><td>{r.drawn}</td><td>{r.lost}</td>
                    <td>{r.goalDifference > 0 ? `+${r.goalDifference}` : r.goalDifference}</td>
                    <td><b>{r.points}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <SourceLine source={source} />
    </div>
  );
}
