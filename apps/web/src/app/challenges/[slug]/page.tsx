import type { Metadata } from 'next';
import { getDict, pick } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import { pageMetadata } from '@/lib/seo';
import { fetchSeoChallenge } from '@/lib/server-api';
import { ChallengeDetail } from './ChallengeDetail';

type Props = { params: Promise<{ slug: string }> };

/** Indexed only when the API's SEO agent says so (open or finished, public, with enough original copy). */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const locale = await getLocale();
  const t = getDict(locale);
  const c = await fetchSeoChallenge(slug);
  if (!c) return pageMetadata({ t, title: t.challenges.title, path: `/challenges/${encodeURIComponent(slug)}`, noindex: true });
  const title = pick(c.title, locale);
  return pageMetadata({
    t,
    title: c.hashtag ? `${title} · #${c.hashtag}` : title,
    description: pick(c.description, locale).slice(0, 200) || t.challenges.intro,
    path: `/challenges/${c.slug}`,
    images: c.thumbnailUrl ? [{ url: c.thumbnailUrl, width: 720, height: 1280, alt: title }] : undefined,
  });
}

export default async function ChallengePage({ params }: Props) {
  const { slug } = await params;
  return <ChallengeDetail slug={slug} />;
}
