'use client';

import { Button } from '@/components/ui/Button';
import { useI18n } from '@/lib/i18n/provider';
import type { SavedSearchView } from '@/lib/types';

/** Human summary of saved scout-search filters, in the viewer's language. */
export function useFilterSummary() {
  const { t } = useI18n();
  return (f: Record<string, unknown>): string => {
    const parts: string[] = [];
    if (typeof f.q === 'string') parts.push(`“${f.q}”`);
    if (typeof f.position === 'string') parts.push(t.positions[f.position as keyof typeof t.positions] ?? f.position);
    if (typeof f.foot === 'string') parts.push(t.feet[f.foot as keyof typeof t.feet] ?? f.foot);
    if (typeof f.country === 'string') parts.push(f.country);
    if (typeof f.skill === 'string') parts.push(t.skills[f.skill as keyof typeof t.skills] ?? f.skill);
    if (typeof f.ageGroup === 'string') parts.push(t.ageBands[f.ageGroup as keyof typeof t.ageBands] ?? f.ageGroup);
    if (f.verifiedOnly === true) parts.push(t.scout.verifiedOnly);
    if (typeof f.minFollowers === 'number' && f.minFollowers > 0) parts.push(`${t.scout.minFollowers}: ${f.minFollowers}`);
    return parts.length ? parts.join(' · ') : t.savedSearches.filtersNone;
  };
}

/** Saved searches with an accessible alert switch per search. Read-only roles see the state without controls. */
export function SavedSearchList({ items, canWrite, busyId, onToggle, onDelete }:
  { items: SavedSearchView[]; canWrite: boolean; busyId?: string | null; onToggle?: (s: SavedSearchView, on: boolean) => void; onDelete?: (s: SavedSearchView) => void }) {
  const { t, fmt } = useI18n();
  const summary = useFilterSummary();
  if (!items.length) return <p className="muted small">{t.savedSearches.empty}</p>;
  return (
    <ul className="list" data-testid="saved-searches">
      {items.map((s) => (
        <li key={s.id}>
          <div className="list__row">
            <strong dir="auto">{s.name}</strong>
            <span className="muted small">{fmt(t.savedSearches.matches, { n: s.matches })}</span>
          </div>
          <p className="muted small" dir="auto">{summary(s.filters)}</p>
          <div className="list__row">
            {canWrite ? (
              <label className="check">
                <input type="checkbox" role="switch" aria-checked={s.alerts} checked={s.alerts} disabled={busyId === s.id}
                  aria-label={fmt(t.savedSearches.alertsFor, { name: s.name })} onChange={(e) => onToggle?.(s, e.target.checked)} />
                {s.alerts ? t.savedSearches.alertsOn : t.savedSearches.alertsOff}
              </label>
            ) : <span className="badge badge--outline">{s.alerts ? t.savedSearches.alertsOn : t.savedSearches.alertsOff}</span>}
            {canWrite ? (
              <Button size="sm" variant="ghost" disabled={busyId === s.id} aria-label={fmt(t.savedSearches.delete, { name: s.name })} onClick={() => onDelete?.(s)}>
                {t.common.delete}
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
