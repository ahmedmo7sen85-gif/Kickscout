import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import Link from 'next/link';
import { LEGAL_DOCS } from '@/lib/legal';
import { getServerDict } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDict();
  return pageMetadata({ t, title: t.legal.hubTitle, description: t.legal.hubIntro, path: '/legal' });
}

export default async function LegalHub() {
  const { t } = await getServerDict();
  return (
    <div className="wrap wrap--mid page">
      <header className="page-head">
        <h1 className="page-title">{t.legal.hubTitle}</h1>
        <p className="page-intro">{t.legal.hubIntro}</p>
      </header>
      <p className="notice notice--warn" role="note"><strong>{t.legal.draftBanner}</strong></p>
      <ul className="list">
        {LEGAL_DOCS.map((d) => (
          <li key={d.slug} className="list__row">
            <span><Link className="link" href={`/legal/${d.slug}`}><strong>{t.legal[d.titleKey]}</strong></Link><br /><span className="muted small" lang="en">{d.summary}</span></span>
          </li>
        ))}
        <li className="list__row"><Link className="link" href="/legal/takedown">{t.legal.takedownTitle}</Link></li>
        <li className="list__row"><Link className="link" href="/legal/counter-notice">{t.legal.counterTitle}</Link></li>
      </ul>
    </div>
  );
}
