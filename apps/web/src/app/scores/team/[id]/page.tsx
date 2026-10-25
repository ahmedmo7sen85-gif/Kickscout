import type { Metadata } from 'next';
import { getDict } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import { pageMetadata } from '@/lib/seo';
import { fetchTeamMeta } from '@/lib/server-api';
import { TeamView } from './TeamView';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const t = getDict(await getLocale());
  const r = await fetchTeamMeta(id);
  const path = `/scores/team/${encodeURIComponent(id)}`;
  if (!r || r.source.testData) return pageMetadata({ t, title: t.football.teamPage, path, noindex: true });
  return pageMetadata({ t, title: r.team.name, description: t.football.teamDescription.replace('{team}', r.team.name), path });
}

export default async function TeamPage({ params }: Props) {
  const { id } = await params;
  return <TeamView id={id} />;
}
