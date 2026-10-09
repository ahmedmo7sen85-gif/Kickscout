import type { Metadata } from 'next';
import { getServerDict } from '@/lib/i18n/server';
import { JudgeView } from './JudgeView';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.challenges.judgeTitle, robots: { index: false, follow: false } };
}

export default function JudgePage() {
  return <JudgeView />;
}
