'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { PageHead } from '@/components/PageHead';
import { PlayerCard } from '@/components/player/PlayerCard';
import { ComingSoonBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SkeletonGrid } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { Tabs } from '@/components/ui/Tabs';
import { HashtagChip } from '@/components/video/SkillChip';
import { VideoCard } from '@/components/video/VideoCard';
import { api } from '@/lib/api';
import { FEET, POSITIONS, SKILL_KEYS } from '@/lib/constants';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { Foot, Position, SkillKey } from '@/lib/types';

type Kind = 'players' | 'videos' | 'hashtags';
const KINDS: Kind[] = ['players', 'videos', 'hashtags'];
const FIELDS = ['q', 'country', 'position', 'foot', 'skill', 'hashtag'] as const;
type Field = (typeof FIELDS)[number];

export function SearchView() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const kindParam = params.get('type');
  const kind: Kind = KINDS.includes(kindParam as Kind) ? (kindParam as Kind) : 'players';
  const current = Object.fromEntries(FIELDS.map((f) => [f, params.get(f) ?? ''])) as Record<Field, string>;
  const [draft, setDraft] = useState(current);
  const key = params.toString();
  useEffect(() => { setDraft(Object.fromEntries(FIELDS.map((f) => [f, params.get(f) ?? ''])) as Record<Field, string>); }, [key, params]);

  const hasQuery = FIELDS.some((f) => current[f]);
  const country = current.country.toUpperCase();
  const res = useApi((s) => api.search({
    type: kind,
    q: current.q || undefined,
    country: /^[A-Z]{2}$/.test(country) ? country : undefined,
    position: (POSITIONS as readonly string[]).includes(current.position) ? (current.position as Position) : undefined,
    foot: (FEET as readonly string[]).includes(current.foot) ? (current.foot as Foot) : undefined,
    skill: (SKILL_KEYS as readonly string[]).includes(current.skill) ? (current.skill as SkillKey) : undefined,
    hashtag: current.hashtag.replace(/^#+/, '') || undefined,
  }, s), [key], { enabled: hasQuery });

  const go = (next: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v.trim()) p.set(k, v.trim());
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  const submit = (e: FormEvent) => { e.preventDefault(); go({ ...draft, type: kind }); };
  const set = (f: Field) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [f]: e.target.value }));
  const tabHref = (k: Kind) => { const p = new URLSearchParams(params.toString()); p.set('type', k); return `${pathname}?${p.toString()}`; };

  return (
    <div className="wrap page">
      <PageHead title={t.search.title} kicker={<span className="row">{t.search.nlComingSoon} <ComingSoonBadge /></span>} />
      <form className="stack" role="search" onSubmit={submit}>
        <div className="row">
          <label htmlFor="q" className="sr-only">{t.search.label}</label>
          <input id="q" type="search" className="input" style={{ flex: 1, minInlineSize: '12rem' }} placeholder={t.search.placeholder} value={draft.q} onChange={set('q')} dir="auto" />
          <Button type="submit" variant="primary">{t.common.search}</Button>
        </div>
        <fieldset className="filters-bar" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">{t.common.filters}</legend>
          <label className="field"><span className="field__label">{t.search.country}</span>
            <input className="input" maxLength={2} value={draft.country} onChange={set('country')} placeholder={t.search.countryPlaceholder} />
          </label>
          <label className="field"><span className="field__label">{t.search.position}</span>
            <select className="input" value={draft.position} onChange={set('position')}>
              <option value="">{t.common.any}</option>{POSITIONS.map((p) => <option key={p} value={p}>{t.positions[p]}</option>)}
            </select>
          </label>
          <label className="field"><span className="field__label">{t.search.foot}</span>
            <select className="input" value={draft.foot} onChange={set('foot')}>
              <option value="">{t.common.any}</option>{FEET.map((f) => <option key={f} value={f}>{t.feet[f]}</option>)}
            </select>
          </label>
          <label className="field"><span className="field__label">{t.search.skill}</span>
            <select className="input" value={draft.skill} onChange={set('skill')}>
              <option value="">{t.common.any}</option>{SKILL_KEYS.map((s) => <option key={s} value={s}>{t.skills[s]}</option>)}
            </select>
          </label>
          <label className="field"><span className="field__label">{t.search.hashtag}</span>
            <input className="input" value={draft.hashtag} onChange={set('hashtag')} maxLength={41} dir="auto" />
          </label>
        </fieldset>
      </form>

      <Tabs label={t.search.title} active={kind} panelId="search-panel"
        items={KINDS.map((k) => ({ id: k, label: t.search[k], href: tabHref(k) }))} />

      <div id="search-panel" role="tabpanel">
        {!hasQuery ? <EmptyState icon="search" title={t.search.title} text={t.search.prompt} /> : null}
        {hasQuery && res.status === 'loading' ? <SkeletonGrid count={6} aspect={kind === 'videos' ? '9 / 16' : '3 / 2'} label={t.common.loading} /> : null}
        {hasQuery && res.status === 'error' ? <ErrorState error={res.error} title={t.search.errorTitle} onRetry={res.retry} /> : null}
        {hasQuery && res.status === 'success' ? (() => {
          const d = res.data;
          const n = kind === 'players' ? d.players.length : kind === 'videos' ? d.videos.length : d.hashtags.length;
          if (!n) return <EmptyState icon="search" title={t.search.empty} text={t.search.emptyText} />;
          if (kind === 'players') return <div className="grid-players">{d.players.map((p) => <PlayerCard key={p.userId} player={p} />)}</div>;
          if (kind === 'videos') return <div className="grid-cards">{d.videos.map((v) => <VideoCard key={v.id} video={v} />)}</div>;
          return <ul className="chips">{d.hashtags.map((h) => <li key={h.tag}><HashtagChip tag={h.tag} count={h.videos} href={`/search?type=videos&hashtag=${encodeURIComponent(h.tag)}`} /></li>)}</ul>;
        })() : null}
      </div>
    </div>
  );
}
