'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { IconButton } from './IconButton';

/**
 * Bottom sheet on phones, centred modal on wider screens. Built on <dialog>, which gives focus
 * trapping, Escape to close and an inert background for free.
 */
export function Sheet({ open, onClose, title, children, footer, size = 'md' }:
  { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; size?: 'md' | 'lg' }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useI18n();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`sheet sheet--${size}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open ? (
        <div className="sheet__inner">
          <header className="sheet__head">
            <h2 id={titleId} className="sheet__title">{title}</h2>
            <IconButton icon="close" label={t.common.close} onClick={onClose} />
          </header>
          <div className="sheet__body">{children}</div>
          {footer ? <footer className="sheet__foot">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}
