import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon';

/** Icon-only button. `label` is required and becomes the accessible name. */
export function IconButton({ icon, label, pressed, active, count, filled, className, ...rest }:
  { icon: IconName; label: string; pressed?: boolean; active?: boolean; count?: string; filled?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={['icon-btn', active ? 'is-active' : '', className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    >
      <Icon name={icon} filled={filled} />
      {count !== undefined ? <span className="icon-btn__count" aria-hidden="true">{count}</span> : null}
    </button>
  );
}
