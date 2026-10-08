import type { CSSProperties } from 'react';

export function Skeleton({ width, height = '1rem', radius, className, style }:
  { width?: string; height?: string; radius?: string; className?: string; style?: CSSProperties }) {
  return <span className={['skeleton', className ?? ''].filter(Boolean).join(' ')} style={{ width, height, borderRadius: radius, ...style }} aria-hidden="true" />;
}

export function SkeletonGrid({ count = 6, aspect = '9 / 16', label }: { count?: number; aspect?: string; label: string }) {
  return (
    <div className="grid-cards" role="status" aria-label={label}>
      {Array.from({ length: count }, (_, i) => <span key={i} className="skeleton" style={{ aspectRatio: aspect, borderRadius: '0.9rem' }} aria-hidden="true" />)}
    </div>
  );
}

export function SkeletonList({ rows = 4, label }: { rows?: number; label: string }) {
  return (
    <div className="stack" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" aria-hidden="true">
          <Skeleton width="3rem" height="3rem" radius="50%" />
          <div className="stack stack--tight" style={{ flex: 1 }}>
            <Skeleton width="40%" />
            <Skeleton width="70%" height="0.8rem" />
          </div>
        </div>
      ))}
    </div>
  );
}
