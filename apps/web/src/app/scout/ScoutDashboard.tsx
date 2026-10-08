'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { PageHead, Section } from '@/components/PageHead';
import { PlayerCard } from '@/components/player/PlayerCard';
import { ScoutActions } from '@/components/player/ScoutActions';
import { ComingSoonBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SkeletonGrid, SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { AGE_BANDS, FEET, POSITIONS, SKILL_KEYS } from '@/lib/constants';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { AgeBand, Foot, PlayerCard as PlayerCardData, Position, ScoutSearchQuery, SkillKey } from '@/lib/types';
import { ScoutGate } from './ScoutGate';

interface Draft { q: string; country: string; position: Position | ''; foot: Foot | ''; skill: SkillKey | ''; ageGroup: AgeBand | ''; verifiedOnly: boolean; minFollowers: string }
const EMPTY: Draft = { q: '', country: '', position: '', foot: '', skill: '', ageGroup: '', verifiedOnly: false, minFollowers: '' };

function toQuery(d: Draft): ScoutSearchQuery {
  const country = d.country.trim().toUpperCase();
  const minF = Number.parseInt(d.minFollowers, 10);
  return {
    q: d.q.trim() || undefined,
    country: /^[A-Z]{2}$/.test(country) ? country : undefined,
    position: d.position || undefined,
    foot: d.foot || undefined,
    skill: d.skill || undefined,
    ageGroup: d.ageGroup || undefined,
    verifiedOnly: d.verifiedOnly || undefined,
    minFollowers: Number.isFinite(minF) && minF > 0 ? minF : undefined,
  };
}

export function ScoutDashboard() {
  return <ScoutGate><Dashboard /></ScoutGate>;
}

function Dashboard() {
  const { t, fmt, formatDate } = useI18n();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [query, setQuery] = useState<ScoutSearchQuery>({});
  const [extra, setExtra] = useState<{ items: PlayerCardData[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actFor, setActFor] = useState<PlayerCardData | null>(null);
  const players = useApi((s) => api.scoutPlayers(query, s), [JSON.stringify(query)]);
  const lists = useApi((s) => api.shortlists(s), []);
  const outgoing = useApi((s) => api.contactRequests('outgoing', s), []);
  const [newList, setNewList] = useState('');
  const [creating, setCreating] = useState(false);

  const submit = (e: FormEvent) => { e.preventDefault(); setExtra(null); setQuery(toQuery(draft)); };
  const items = players.status === 'success' ? [...players.data.items, ...(extra?.items ?? [])] : [];
  const cursor = players.status === 'success' ? (extra ? extra.cursor : players.data.nextCursor) : null;
  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const p = await api.scoutPlayers({ ...query, cursor });
      setExtra((x) => ({ items: [...(x?.items ?? []), ...p.items], cursor: p.nextCursor }));
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setLoadingMore(false); }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!newList.trim()) return;
    setCreating(true);
    try { await api.createShortlist({ name: newList.trim() }); setNewList(''); lists.retry(); } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setCreating(false); }
  };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <div className="wrap page" style={{ maxInlineSize: '90rem' }}>
      <PageHead title={t.scout.title} intro={t.scout.intro} actions={<span className="row small muted">{t.scout.compare} <ComingSoonBadge /></span>} />
      <div className="split">
        <aside className="stack">
          <form className="card" onSubmit={submit} aria-label={t.scout.searchTitle}>
            <h2 className="section-title" style={{ fontSize: '1.1rem' }}>{t.scout.searchTitle}</h2>
            <label className="field"><span className="field__label">{t.scout.query}</span>
              <input className="input" value={draft.q} onChange={(e) => set('q', e.target.value)} dir="auto" /></label>
            <label className="field"><span className="field__label">{t.search.country}</span>
              <input className="input" maxLength={2} placeholder={t.search.countryPlaceholder} value={draft.country} onChange={(e) => set('country', e.target.value)} /></label>
            <label className="field"><span className="field__label">{t.search.position}</span>
              <select className="input" value={draft.position} onChange={(e) => set('position', e.target.value as Position | '')}>
                <option value="">{t.common.any}</option>{POSITIONS.map((p) => <option key={p} value={p}>{t.positions[p]}</option>)}</select></label>
            <label className="field"><span className="field__label">{t.search.foot}</span>
              <select className="input" value={draft.foot} onChange={(e) => set('foot', e.target.value as Foot | '')}>
                <option value="">{t.common.any}</option>{FEET.map((f) => <option key={f} value={f}>{t.feet[f]}</option>)}</select></label>
            <label className="field"><span className="field__label">{t.search.skill}</span>
              <select className="input" value={draft.skill} onChange={(e) => set('skill', e.target.value as SkillKey | '')}>
                <option value="">{t.common.any}</option>{SKILL_KEYS.map((s) => <option key={s} value={s}>{t.skills[s]}</option>)}</select></label>
            <label className="field"><span className="field__label">{t.scout.ageGroup}</span>
              <select className="input" value={draft.ageGroup} onChange={(e) => set('ageGroup', e.target.value as AgeBand | '')}>
                <option value="">{t.common.any}</option>{AGE_BANDS.map((a) => <option key={a} value={a}>{t.ageBands[a]}</option>)}</select></label>
            <label className="field"><span className="field__label">{t.scout.minFollowers}</span>
              <input className="input" type="number" min={0} inputMode="numeric" value={draft.minFollowers} onChange={(e) => set('minFollowers', e.target.value)} /></label>
            <label className="check"><input type="checkbox" checked={draft.verifiedOnly} onChange={(e) => set('verifiedOnly', e.target.checked)} />{t.scout.verifiedOnly}</label>
            <div className="row">
              <Button type="submit" variant="primary">{t.common.search}</Button>
              <Button variant="ghost" onClick={() => { setDraft(EMPTY); setExtra(null); setQuery({}); }}>{t.common.clear}</Button>
            </div>
          </form>

          <section className="card" aria-labelledby="sl-title">
            <h2 className="section-title" id="sl-title" style={{ fontSize: '1.1rem' }}>{t.scout.shortlists}</h2>
            {lists.status === 'loading' ? <SkeletonList rows={2} label={t.common.loading} /> : null}
            {lists.status === 'error' ? <ErrorState error={lists.error} title={t.scout.errorTitle} onRetry={lists.retry} /> : null}
            {lists.status === 'success' && !lists.data.items.length ? <p className="muted small">{t.scout.shortlistsEmpty}</p> : null}
            {lists.status === 'success' && lists.data.items.length ? (
              <ul className="list">
                {lists.data.items.map((l) => (
                  <li key={l.id} className="list__row">
                    <Link href={`/scout/shortlists/${l.id}`} className="link">{l.name}</Link>
                    <span className="muted small">{fmt(t.common.playersCount, { n: l.players })}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <form className="row" onSubmit={create}>
              <label className="sr-only" htmlFor="new-sl">{t.scout.shortlistName}</label>
              <input id="new-sl" className="input" style={{ flex: 1 }} placeholder={t.scout.newShortlist} maxLength={80} value={newList} onChange={(e) => setNewList(e.target.value)} />
              <Button type="submit" size="sm" loading={creating} disabled={!newList.trim()}>{t.scout.create}</Button>
            </form>
          </section>
        </aside>

        <div className="stack stack--loose">
          <Section title={t.scout.results} id="results">
            {players.status === 'loading' ? <SkeletonGrid count={6} aspect="4 / 3" label={t.common.loading} /> : null}
            {players.status === 'error' ? <ErrorState error={players.error} title={t.scout.errorTitle} onRetry={players.retry} /> : null}
            {players.status === 'success' && !items.length ? <EmptyState icon="scout" title={t.scout.noResults} /> : null}
            {items.length ? (
              <div className="grid-players">
                {items.map((p) => (
                  <PlayerCard key={p.userId} player={p} footer={<Button size="sm" variant="primary" onClick={() => setActFor(p)}>{t.profile.scoutAction}</Button>} />
                ))}
              </div>
            ) : null}
            {cursor ? <div><Button onClick={more} loading={loadingMore}>{t.common.loadMore}</Button></div> : null}
          </Section>

          <Section title={t.scout.outgoing} id="outgoing">
            {outgoing.status === 'loading' ? <SkeletonList rows={2} label={t.common.loading} /> : null}
            {outgoing.status === 'error' ? <ErrorState error={outgoing.error} onRetry={outgoing.retry} /> : null}
            {outgoing.status === 'success' && !outgoing.data.items.length ? <p className="muted small">{t.scout.outgoingEmpty}</p> : null}
            {outgoing.status === 'success' && outgoing.data.items.length ? (
              <ul className="list">
                {outgoing.data.items.map((r) => (
                  <li key={r.id}>
                    <div className="list__row">
                      <Link href={`/u/${r.player.handle}`} className="link">@{r.player.handle}</Link>
                      <span className="row">
                        {r.viaGuardian ? <span className="badge badge--outline">{t.contact.viaGuardian}</span> : null}
                        <span className={`badge ${r.status === 'accepted' ? 'badge--green' : 'badge--outline'}`}>{t.contact[r.status]}</span>
                        <time className="muted small" dateTime={r.createdAt}>{formatDate(r.createdAt)}</time>
                      </span>
                    </div>
                    <p className="muted small" dir="auto">{r.message}</p>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        </div>
      </div>
      {actFor ? (
        <ScoutActions playerId={actFor.userId} playerName={actFor.displayName} canRequestContact isMinor={actFor.ageGroup ? actFor.ageGroup !== 'adult' : null}
          open onClose={() => { setActFor(null); lists.retry(); }} />
      ) : null}
    </div>
  );
}
