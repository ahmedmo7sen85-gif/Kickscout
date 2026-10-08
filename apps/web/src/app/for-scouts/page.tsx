import type { Metadata } from 'next';
import { ButtonLink } from '@/components/ui/Button';
import { getServerDict } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return { title: t.nav.forScouts, description: t.pages.forScoutsIntro };
}

export default async function ForScoutsPage() {
  const { t } = await getServerDict();
  const P = t.pages;
  return (
    <div className="wrap wrap--mid page">
      <header className="page-head">
        <p className="kicker">{t.nav.forScouts}</p>
        <h1 className="display">{P.forScoutsTitle}</h1>
        <p className="lede">{P.forScoutsIntro}</p>
      </header>
      <ol className="steps">
        {[P.forScoutsStep1, P.forScoutsStep2, P.forScoutsStep3, P.forScoutsStep4].map((s, i) => (
          <li key={s} className="step"><span className="step__arrow" aria-hidden="true">0{i + 1}</span><p style={{ color: 'var(--text)' }}>{s}</p></li>
        ))}
      </ol>
      <p className="notice notice--accent">{P.forScoutsHonest}</p>
      <div className="cta-row">
        <ButtonLink href="/scout" variant="primary" size="lg">{t.scout.title}</ButtonLink>
        <ButtonLink href="/signup">{t.common.signUp}</ButtonLink>
        <ButtonLink href="/radar" variant="ghost">{t.nav.radar}</ButtonLink>
      </div>
    </div>
  );
}
