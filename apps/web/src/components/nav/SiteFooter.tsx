'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/lib/i18n/provider';
import { LEGAL_DOCS } from '@/lib/legal';

export function SiteFooter() {
  const pathname = usePathname();
  const { t } = useI18n();
  if (pathname === '/home') return null;
  return (
    <footer className="site-footer">
      <div className="wrap">
        <span>{t.landing.footerTagline}</span>
        <nav aria-label="Footer">
          <ul>
            <li><Link href="/for-players">{t.nav.forPlayers}</Link></li>
            <li><Link href="/for-scouts">{t.nav.forScouts}</Link></li>
            <li><Link href="/safety">{t.landing.safetyKicker}</Link></li>
            <li><Link href="/challenges">{t.nav.challenges}</Link></li>
          </ul>
        </nav>
        <nav aria-label={t.legal.footerLegal}>
          <ul>
            {LEGAL_DOCS.map((d) => <li key={d.slug}><Link href={`/legal/${d.slug}`}>{t.legal[d.titleKey]}</Link></li>)}
            <li><Link href="/legal/takedown">{t.legal.takedownLink}</Link></li>
          </ul>
        </nav>
        {pathname === '/' ? <span>{t.landing.footerAi}</span> : null}
      </div>
    </footer>
  );
}
