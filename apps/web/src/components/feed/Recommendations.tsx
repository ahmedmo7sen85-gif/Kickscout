'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { FeedWhy, RecommendationSettingsView } from '@/lib/types';

/** Presentational: the "Personalize my feed" switch, the "Not interested" summary and the reset button. */
export function RecommendationControls({ settings, busy, onToggle, onReset }:
  { settings: RecommendationSettingsView; busy: boolean; onToggle: (on: boolean) => void; onReset: () => void }) {
  const { t, fmt, formatDate } = useI18n();
  const r = t.recommendations;
  const ni = settings.notInterested;
  return (
    <div className="stack">
      {!settings.available ? <p className="muted small" role="note">{r.unavailable}</p> : null}
      <div className="list__row">
        <span>
          <strong id="rec-personalize">{r.personalize}</strong><br />
          <span className="muted small">{r.personalizeHint}</span>
        </span>
        <button type="button" role="switch" className="toggle" aria-checked={settings.personalize} aria-labelledby="rec-personalize"
          disabled={busy} onClick={() => onToggle(!settings.personalize)}>
          <span className="sr-only">{settings.personalize ? t.settings.granted : t.settings.notGranted}</span>
        </button>
      </div>
      <p className="muted small" data-testid="rec-summary">{fmt(r.notInterestedSummary, { videos: ni.videos, players: ni.players, skills: ni.skills.length })}</p>
      {settings.historyResetAt ? <p className="muted small">{fmt(r.lastReset, { date: formatDate(settings.historyResetAt) })}</p> : null}
      <div className="stack" style={{ gap: '0.25rem' }}>
        <div><Button onClick={onReset} loading={busy}>{r.reset}</Button></div>
        <p className="muted small">{r.resetHint}</p>
      </div>
    </div>
  );
}

/** Settings section for For You. */
export function RecommendationSettings() {
  const { t } = useI18n();
  const toast = useToast();
  const s = useApi((sig) => api.recommendations(sig), []);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<RecommendationSettingsView>, done: string) => {
    setBusy(true);
    try {
      const next = await fn();
      s.setData(() => next);
      toast.show(done, { tone: 'success' });
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <section className="card" aria-labelledby="s-rec" id="recommendations">
      <h2 className="section-title" id="s-rec">{t.recommendations.title}</h2>
      <p className="muted small">{t.recommendations.intro}</p>
      {s.status === 'loading' ? <SkeletonList rows={2} label={t.common.loading} /> : null}
      {s.status === 'error' ? <ErrorState error={s.error} onRetry={s.retry} /> : null}
      {s.status === 'success' ? (
        <RecommendationControls settings={s.data} busy={busy}
          onToggle={(on) => act(() => api.updateRecommendations({ personalize: on }), t.recommendations.saved)}
          onReset={() => act(() => api.resetRecommendations(), t.recommendations.resetDone)} />
      ) : null}
    </section>
  );
}

/** "Why am I seeing this?" for one For You clip, with its "Not interested" action. */
export function WhyThis({ why, onNotInterested }: { why: FeedWhy | undefined; onNotInterested?: () => void }) {
  const { t, pick } = useI18n();
  const id = useId();
  if (!why && !onNotInterested) return null;
  return (
    <div className="row small" data-testid="feed-why">
      {why ? (
        <details>
          <summary>{t.recommendations.why}</summary>
          <p id={id} dir="auto" data-reason={why.code}>{pick(why.text)}</p>
        </details>
      ) : null}
      {onNotInterested ? (
        <button type="button" className="chip chip--sm" onClick={onNotInterested} aria-describedby={why ? id : undefined}>{t.recommendations.notInterested}</button>
      ) : null}
    </div>
  );
}
