'use client';

import Link from 'next/link';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem<K extends string> { id: K; label: string; extra?: ReactNode; href?: string }

/**
 * Accessible tabs. With `href` on items they render as links (for URL-driven tabs); otherwise as
 * buttons with roving focus and arrow-key navigation.
 */
export function Tabs<K extends string>({ items, active, onChange, label, panelId, className }:
  { items: TabItem<K>[]; active: K; onChange?: (id: K) => void; label: string; panelId?: string; className?: string }) {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (!forward && !back) return;
    e.preventDefault();
    const rtl = getComputedStyle(e.currentTarget as Element).direction === 'rtl';
    const step = (forward ? 1 : -1) * (rtl && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') ? -1 : 1);
    const next = (i + step + items.length) % items.length;
    refs.current[next]?.focus();
    const item = items[next];
    if (item && !item.href) onChange?.(item.id);
  };
  return (
    <div role="tablist" aria-label={label} className={['tabs', className ?? ''].filter(Boolean).join(' ')}>
      {items.map((it, i) => {
        const selected = it.id === active;
        const common = {
          role: 'tab' as const,
          'aria-selected': selected,
          'aria-controls': panelId,
          tabIndex: selected ? 0 : -1,
          className: `tab${selected ? ' is-active' : ''}`,
          onKeyDown: (e: KeyboardEvent) => onKey(e, i),
        };
        return it.href ? (
          <Link key={it.id} href={it.href} ref={(el) => { refs.current[i] = el; }} {...common} onClick={() => onChange?.(it.id)} scroll={false}>
            {it.label}{it.extra}
          </Link>
        ) : (
          <button key={it.id} type="button" ref={(el) => { refs.current[i] = el; }} {...common} onClick={() => onChange?.(it.id)}>
            {it.label}{it.extra}
          </button>
        );
      })}
    </div>
  );
}
