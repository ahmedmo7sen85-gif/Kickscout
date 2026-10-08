'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/lib/i18n/provider';

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
        {pathname === '/' ? <span>{t.landing.footerAi}</span> : null}
      </div>
    </footer>
  );
}
