import type { Metadata } from 'next';
import { JsonLd } from '@/components/JsonLd';
import { publicEnv } from '@/lib/env';
import { getDict } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import { matchJsonLd, pageMetadata } from '@/lib/seo';
import { fetchMatchMeta } from '@/lib/server-api';
import { MatchDetail } from './MatchDetail';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const t = getDict(await getLocale());
  const r = await fetchMatchMeta(id);
  const path = `/scores/match/${encodeURIComponent(id)}`;
  // Unknown matches and invented test data are never indexed.
  if (!r || r.source.testData) return pageMetadata({ t, title: t.football.scoresTitle, path, noindex: true });
  const vars = { home: r.match.home.name, away: r.match.away.name, competition: r.match.competition.name };
  const fmt = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k as keyof typeof vars] ?? '');
  return pageMetadata({ t, title: fmt(t.football.matchTitle), description: fmt(t.football.matchDescription), path });
}

export default async function MatchPage({ params }: Props) {
  const { id } = await params;
  const r = await fetchMatchMeta(id);
  return (
    <>
      {r && !r.source.testData ? <JsonLd data={matchJsonLd(r, publicEnv.siteUrl)} /> : null}
      <MatchDetail id={id} />
    </>
  );
}
