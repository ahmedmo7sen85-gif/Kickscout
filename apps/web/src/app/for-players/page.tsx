import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { ButtonLink } from '@/components/ui/Button';
import { getServerDict } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.nav.forPlayers, description: t.pages.forPlayersIntro, path: '/for-players' });
}

export default async function ForPlayersPage() {
  const { t } = await getServerDict();
  const P = t.pages;
  return (
    <div className="wrap wrap--mid page">
      <header className="page-head">
        <p className="kicker">{t.nav.forPlayers}</p>
        <h1 className="display">{P.forPlayersTitle}</h1>
        <p className="lede">{P.forPlayersIntro}</p>
      </header>
      <ol className="steps">
        {[P.forPlayersStep1, P.forPlayersStep2, P.forPlayersStep3, P.forPlayersStep4].map((s, i) => (
          <li key={s} className="step"><span className="step__arrow" aria-hidden="true">0{i + 1}</span><p style={{ color: 'var(--text)' }}>{s}</p></li>
        ))}
      </ol>
      <p className="notice">{P.forPlayersPrivacy}</p>
      <div className="cta-row">
        <ButtonLink href="/upload" variant="primary" size="lg">{t.landing.ctaShow}</ButtonLink>
        <ButtonLink href="/signup">{t.common.signUp}</ButtonLink>
        <ButtonLink href="/safety" variant="ghost">{t.landing.safetyCta}</ButtonLink>
      </div>
    </div>
  );
}
