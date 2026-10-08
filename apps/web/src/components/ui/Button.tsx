import Link from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const cls = (variant: ButtonVariant, size: Size, block?: boolean, extra?: string) =>
  ['btn', `btn--${variant}`, `btn--${size}`, block ? 'btn--block' : '', extra ?? ''].filter(Boolean).join(' ');

export function Button({ variant = 'secondary', size = 'md', block, loading, className, children, disabled, ...rest }:
  { variant?: ButtonVariant; size?: Size; block?: boolean; loading?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cls(variant, size, block, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function ButtonLink({ href, variant = 'secondary', size = 'md', block, className, children, ...rest }:
  { href: string; variant?: ButtonVariant; size?: Size; block?: boolean; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return <Link href={href} className={cls(variant, size, block, className)} {...rest}>{children}</Link>;
}
