'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';
import { BOTTOM_ITEMS, isActive } from './links';

/** Mobile bottom navigation: Home, Discover, Upload, Talent Radar, Profile. */
export function BottomNav() {
  const pathname = usePathname();
  const { t } = useI18n();
  const { me } = useAuth();
  const profileHref = me ? `/u/${me.profile.handle}` : '/login';
  return (
    <nav className="bottom-nav" aria-label={t.nav.mobileLabel} data-testid="bottom-nav">
      <ul>
        {BOTTOM_ITEMS.map((it) => {
          const href = it.key === 'profile' ? profileHref : it.href;
          const active = it.key === 'profile' ? pathname.startsWith('/u/') || pathname === '/settings' : isActive(pathname, it.href);
          return (
            <li key={it.key}>
              <Link href={href} className={`bottom-nav__item${it.key === 'upload' ? ' bottom-nav__item--upload' : ''}${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}>
                <span className="bottom-nav__icon"><Icon name={it.icon} size={it.key === 'upload' ? 24 : 22} /></span>
                <span className="bottom-nav__label">{t.nav[it.key]}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
