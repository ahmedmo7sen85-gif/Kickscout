import type { Metadata } from 'next';
import { getDict } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import { pageMetadata } from '@/lib/seo';
import { fetchStandingsMeta } from '@/lib/server-api';
import { StandingsTable } from './StandingsTable';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const t = getDict(await getLocale());
  const r = await fetchStandingsMeta(id);
  const path = `/scores/competition/${encodeURIComponent(id)}`;
  if (!r || r.source.testData) return pageMetadata({ t, title: t.football.standings, path, noindex: true });
  return pageMetadata({ t, title: `${r.competition.name} · ${t.football.standings}`, description: t.football.competitionDescription.replace('{competition}', r.competition.name), path });
}

export default async function CompetitionPage({ params }: Props) {
  const { id } = await params;
  return <StandingsTable id={id} />;
}
