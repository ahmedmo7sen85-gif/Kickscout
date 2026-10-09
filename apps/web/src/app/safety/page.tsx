import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { getServerDict } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.pages.safetyTitle, description: t.pages.safetyIntro, path: '/safety' });
}

export default async function SafetyPage() {
  const { t } = await getServerDict();
  const P = t.pages;
  const items = [
    [P.safetyMinorsTitle, P.safetyMinorsText], [P.safetyContactTitle, P.safetyContactText], [P.safetyAiTitle, P.safetyAiText],
    [P.safetyModerationTitle, P.safetyModerationText], [P.safetyDataTitle, P.safetyDataText], [P.safetyPromoTitle, P.safetyPromoText],
  ];
  return (
    <div className="wrap wrap--mid page">
      <header className="page-head">
        <p className="kicker">{t.landing.safetyKicker}</p>
        <h1 className="display">{P.safetyTitle}</h1>
        <p className="lede">{P.safetyIntro}</p>
      </header>
      <div className="trust">
        {items.map(([h, p]) => <div key={h}><h2 style={{ fontSize: '1.05rem', marginBlockEnd: '0.35rem' }}>{h}</h2><p>{p}</p></div>)}
      </div>
    </div>
  );
}
