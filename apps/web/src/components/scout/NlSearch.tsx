'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { api, isApiError } from '@/lib/api';
import { countryName } from '@/lib/format';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import type { NlScoutSearchResponse, ScoutSearchQuery } from '@/lib/types';

export type ScoutFilterKey = 'q' | 'position' | 'foot' | 'ageGroup' | 'country' | 'skill' | 'verifiedOnly' | 'minFollowers';
const CHIP_ORDER: readonly ScoutFilterKey[] = ['position', 'foot', 'ageGroup', 'country', 'skill', 'verifiedOnly', 'minFollowers', 'q'];

/** The search filters as removable chips: every interpreted filter is visible and can be dropped. */
export function FilterChips({ filters, onRemove }: { filters: ScoutSearchQuery; onRemove: (key: ScoutFilterKey) => void }) {
  const { t, fmt, locale } = useI18n();
  const n = t.nlSearch;
  const chips = CHIP_ORDER.flatMap((key) => {
    const v = filters[key];
    if (v === undefined || v === null || v === '' || v === false) return [];
    const label = (() => {
      switch (key) {
        case 'position': return `${n.filterPosition}: ${t.positions[filters.position!]}`;
        case 'foot': return `${n.filterFoot}: ${t.feet[filters.foot!]}`;
        case 'ageGroup': return `${n.filterAge}: ${t.ageBands[filters.ageGroup!]}`;
        case 'country': return `${n.filterCountry}: ${countryName(filters.country!, locale)}`;
        case 'skill': return `${n.filterSkill}: ${t.skills[filters.skill!]}`;
        case 'verifiedOnly': return n.filterVerified;
        case 'minFollowers': return fmt(n.filterFollowers, { n: Number(filters.minFollowers) });
        case 'q': return `${n.filterName}: ${filters.q}`;
      }
    })();
    return [{ key, label }];
  });
  if (!chips.length) return <p className="muted small" data-testid="nl-no-filters">{n.noFilters}</p>;
  return (
    <ul className="chips" aria-label={n.filtersLabel} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {chips.map((c) => (
        <li key={c.key}>
          <button type="button" className="chip chip--sm is-active" data-filter={c.key} aria-label={fmt(n.remove, { name: c.label })} onClick={() => onRemove(c.key)}>
            <span dir="auto">{c.label}</span><span aria-hidden="true">×</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** What the parser understood, and who read it (AI model or the built-in rules). */
export function NlInterpretation({ result }: { result: Pick<NlScoutSearchResponse, 'parser' | 'model' | 'explanation'> }) {
  const { t, fmt, pick } = useI18n();
  return (
    <div className="stack" style={{ gap: '0.35rem' }} data-testid="nl-interpretation">
      <p className="small"><strong>{t.nlSearch.interpreted}:</strong> <span dir="auto">{pick(result.explanation)}</span></p>
      <p className="muted small" data-parser={result.parser}>
        {result.parser === 'ai' ? fmt(t.nlSearch.parserAi, { model: result.model ?? '' }) : t.nlSearch.parserRules}
      </p>
    </div>
  );
}

/** Free-text scout search box. Results come back with the filters they used. */
export function NlSearchBox({ onResult }: { onResult: (r: NlScoutSearchResponse) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const query = text.trim();
    if (!query) return;
    setBusy(true);
    try {
      onResult(await api.scoutSearchNl({ query }));
    } catch (err) {
      if (isApiError(err) && err.code === 'FEATURE_DISABLED') setDisabled(true);
      else toast.show(errorMessage(err, t), { tone: 'error' });
    } finally { setBusy(false); }
  };
  return (
    <form className="card stack" onSubmit={submit} aria-label={t.nlSearch.title}>
      <h2 className="section-title" style={{ fontSize: '1.1rem' }}>{t.nlSearch.title}</h2>
      {disabled ? <p className="muted small" role="status">{t.nlSearch.disabled}</p> : null}
      <label className="field"><span className="field__label">{t.nlSearch.label}</span>
        <textarea className="input" rows={2} maxLength={300} dir="auto" placeholder={t.nlSearch.placeholder} value={text}
          onChange={(e) => setText(e.target.value)} disabled={disabled} /></label>
      <p className="muted small">{t.nlSearch.hint} {t.nlSearch.countsAsSearch}</p>
      <div><Button type="submit" variant="primary" loading={busy} disabled={disabled || !text.trim()}>{t.nlSearch.submit}</Button></div>
    </form>
  );
}
