import { ChallengeDetail } from './ChallengeDetail';

export default async function ChallengePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ChallengeDetail slug={slug} />;
}
