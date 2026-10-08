import type { Metadata } from 'next';
import { AuthForm } from '@/components/AuthForm';
import { getServerDict } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.auth.loginTitle, robots: { index: false } };
}

export default function Page() {
  return <div className="wrap page"><AuthForm mode="login" /></div>;
}
