'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';
import { isActive } from './links';
import { LocaleSwitch } from './LocaleSwitch';

export function Logo() {
  const { t } = useI18n();
  return <Link href="/" className="logo" aria-label={t.nav.homeLabel}>KICK<b>SCOUT</b></Link>;
}

/**
 * Desktop: Home, Discover, Talent Radar, Challenges, Play, Upload, then For Players, For Scouts,
 * Notifications, Profile. Phones get a compact bar (with Play and Notifications); the bottom nav carries the main items.
 */
export function TopNav() {
  const pathname = usePathname();
  const { t, fmt } = useI18n();
  const { me, status, isScout, isStaff } = useAuth();
  const unread = me?.unreadNotifications ?? 0;
  const profileHref = me ? `/u/${me.profile.handle}` : '/login';

  const primary = [
    { href: '/home', label: t.nav.home },
    { href: '/discover', label: t.nav.discover },
    { href: '/radar', label: t.nav.radar },
    { href: '/challenges', label: t.nav.challenges },
    { href: '/play', label: t.nav.play },
  ];
  const link = (href: string, label: string, extra = '') => {
    const active = isActive(pathname, href);
    return (
      <Link href={href} className={`top-nav__link${active ? ' is-active' : ''} ${extra}`} aria-current={active ? 'page' : undefined}>{label}</Link>
    );
  };

  return (
    <header className={`top-nav${pathname === '/home' ? ' top-nav--overlay' : ''}`}>
      <nav className="top-nav__inner" aria-label={t.nav.mainLabel}>
        <Logo />
        <ul className="top-nav__primary">
          {primary.map((p) => <li key={p.href}>{link(p.href, p.label)}</li>)}
          <li>
            <Link href="/upload" className={`top-nav__upload${isActive(pathname, '/upload') ? ' is-active' : ''}`} aria-current={isActive(pathname, '/upload') ? 'page' : undefined}>
              <Icon name="plus" size={18} />{t.nav.upload}
            </Link>
          </li>
        </ul>
        <ul className="top-nav__secondary">
          <li className="top-nav__desktop">{link('/for-players', t.nav.forPlayers)}</li>
          <li className="top-nav__desktop">{link('/for-scouts', t.nav.forScouts)}</li>
          <li className="top-nav__mobile">
            <Link href="/play" className={`top-nav__icon${isActive(pathname, '/play') ? ' is-active' : ''}`} aria-label={t.nav.play} title={t.nav.play}>
              <Icon name="ball" />
            </Link>
          </li>
          <li>
            <Link href="/notifications" className={`top-nav__icon${isActive(pathname, '/notifications') ? ' is-active' : ''}`}
              aria-label={unread ? `${t.nav.notifications}, ${fmt(t.nav.unread, { n: unread })}` : t.nav.notifications} title={t.nav.notifications}>
              <Icon name="bell" />
              {unread ? <span className="dot" aria-hidden="true" /> : null}
            </Link>
          </li>
          <li className="top-nav__desktop">
            <Link href={profileHref} className={`top-nav__link${pathname.startsWith('/u/') ? ' is-active' : ''}`}
              aria-current={pathname.startsWith('/u/') ? 'page' : undefined}>{t.nav.profile}</Link>
          </li>
          <li className="top-nav__desktop">
            {status === 'signed_in'
              ? <Link href="/settings" className="top-nav__icon" aria-label={t.nav.settings} title={t.nav.settings}><Icon name="settings" /></Link>
              : <Link href="/login" className="btn btn--secondary btn--sm">{t.common.logIn}</Link>}
          </li>
          {isScout ? <li className="top-nav__desktop">{link('/scout', t.nav.scout)}</li> : null}
          {isScout ? <li className="top-nav__desktop">{link('/scout/pipeline', t.nav.pipeline)}</li> : null}
          {isStaff ? <li className="top-nav__desktop">{link('/admin', t.nav.admin)}</li> : null}
          <li>
            <Link href="/search" className={`top-nav__icon${isActive(pathname, '/search') ? ' is-active' : ''}`} aria-label={t.nav.search} title={t.nav.search}><Icon name="search" /></Link>
          </li>
          <li><LocaleSwitch /></li>
        </ul>
      </nav>
    </header>
  );
}
