'use client';

import { useState, type FormEvent } from 'react';
import { PageHead } from '@/components/PageHead';
import { PlayerCard } from '@/components/player/PlayerCard';
import { CapabilityBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { api } from '@/lib/api';
import { POSITIONS, RADAR_CATEGORIES, SKILL_KEYS } from '@/lib/constants';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { Position, RadarCategory, RadarQuery, SkillKey } from '@/lib/types';
import { Tabs } from '@/components/ui/Tabs';

/**
 * Talent Radar: who is getting attention and why. The API's disclaimer is always shown first, and
 * each player lists the reasons they appear. No ranking value or score is displayed.
 */
export function RadarView() {
  const { t, pick } = useI18n();
  const [category, setCategory] = useState<RadarCategory>('rising');
  const [filters, setFilters] = useState<RadarQuery>({});
  const [draft, setDraft] = useState<{ country: string; position: Position | ''; skill: SkillKey | '' }>({ country: '', position: '', skill: '' });
  const r = useApi((s) => api.radar({ ...filters, category }, s), [category, filters.country, filters.position, filters.skill]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const country = draft.country.trim().toUpperCase();
    setFilters({ country: /^[A-Z]{2}$/.test(country) ? country : undefined, position: draft.position || undefined, skill: draft.skill || undefined });
  };

  return (
    <div className="wrap page">
      <PageHead title={t.radar.title} intro={t.radar.intro} kicker={<span className="row"><span className="radar-dot" aria-hidden="true" /> {t.nav.radar}</span>} />

      {r.status === 'success' ? (
        <aside className="disclaimer" aria-label={t.radar.title} data-testid="radar-disclaimer">
          <strong><span className="radar-dot" aria-hidden="true" />{t.radar.title}</strong>
          <p>{pick(r.data.disclaimer)}</p>
          <CapabilityBadge capability={r.data.capability} />
        </aside>
      ) : null}

      <Tabs label={t.radar.categoriesLabel} active={category} onChange={setCategory} panelId="radar-panel"
        items={RADAR_CATEGORIES.map((c) => ({ id: c, label: t.radar[c] }))} />

      <form className="filters-bar" onSubmit={apply} aria-label={t.radar.filtersLabel}>
        <label className="field"><span className="field__label">{t.search.country}</span>
          <input className="input" value={draft.country} maxLength={2} placeholder={t.search.countryPlaceholder}
            onChange={(e) => setDraft({ ...draft, country: e.target.value })} />
        </label>
        <label className="field"><span className="field__label">{t.search.position}</span>
          <select className="input" value={draft.position} onChange={(e) => setDraft({ ...draft, position: e.target.value as Position | '' })}>
            <option value="">{t.common.any}</option>
            {POSITIONS.map((p) => <option key={p} value={p}>{t.positions[p]}</option>)}
          </select>
        </label>
        <label className="field"><span className="field__label">{t.search.skill}</span>
          <select className="input" value={draft.skill} onChange={(e) => setDraft({ ...draft, skill: e.target.value as SkillKey | '' })}>
            <option value="">{t.common.any}</option>
            {SKILL_KEYS.map((s) => <option key={s} value={s}>{t.skills[s]}</option>)}
          </select>
        </label>
        <Button type="submit" variant="secondary">{t.common.apply}</Button>
      </form>

      <div id="radar-panel" role="tabpanel" aria-label={t.radar[category]} className="stack">
      {r.status === 'loading' ? <SkeletonList rows={5} label={t.common.loading} /> : null}
      {r.status === 'error' ? <ErrorState error={r.error} title={t.radar.errorTitle} onRetry={r.retry} /> : null}
      {r.status === 'success' && r.data.items.length === 0 ? <EmptyState icon="radar" title={t.states.emptyTitle} text={t.radar.empty} /> : null}
      {r.status === 'success' && r.data.items.length > 0 ? (
        <ol className="grid-players">
          {r.data.items.map((it) => (
            <li key={it.player.userId}>
              <PlayerCard player={it.player}>
                {it.reasons.length ? (
                  <div className="stack stack--tight">
                    <p className="reasons__head">{t.radar.trendingBecause}</p>
                    <ul className="reasons">{it.reasons.map((x) => <li key={x.code}>{pick(x.text)}</li>)}</ul>
                  </div>
                ) : null}
              </PlayerCard>
            </li>
          ))}
        </ol>
      ) : null}
      </div>
    </div>
  );
}
