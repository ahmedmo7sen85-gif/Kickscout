import type { IconName } from '@/components/ui/Icon';

export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export type NavKey = 'home' | 'discover' | 'upload' | 'radar' | 'profile';
export const BOTTOM_ITEMS: { key: NavKey; href: string; icon: IconName }[] = [
  { key: 'home', href: '/home', icon: 'home' },
  { key: 'discover', href: '/discover', icon: 'discover' },
  { key: 'upload', href: '/upload', icon: 'plus' },
  { key: 'radar', href: '/radar', icon: 'radar' },
  { key: 'profile', href: '/profile', icon: 'user' },
];
