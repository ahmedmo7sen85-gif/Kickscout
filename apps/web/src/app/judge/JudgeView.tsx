'use client';

import { useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { PageHead } from '@/components/PageHead';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import type { JudgeItemView, JudgeReviewRequest } from '@/lib/types';
import { useApi } from '@/lib/useApi';

/** Blind judging: the clip, the rubric and the automatic checks, never who the player is. The API decides who may judge. */
export function JudgeView() {
  const { t } = useI18n();
  return (
    <div className="wrap wrap--mid page">
      <PageHead title={t.challenges.judgeTitle} intro={t.challenges.judgeIntro} />
      <AuthGate><Queue /></AuthGate>
    </div>
  );
}

function Queue() {
  const { t } = useI18n();
  const q = useApi((s) => api.judgeQueue({}, s), []);
  if (q.status === 'loading') return <SkeletonList rows={4} label={t.common.loading} />;
  if (q.status === 'error') return <ErrorState error={q.error} onRetry={q.retry} />;
  const items = q.data.items.filter((i) => !i.reviewedByMe);
  if (!items.length) return <EmptyState icon="shield" title={t.challenges.judgeEmpty} />;
  return <div className="stack stack--loose">{items.map((i) => <JudgeCard key={i.submissionId} item={i} onDone={q.retry} />)}</div>;
}

function JudgeCard({ item, onDone }: { item: JudgeItemView; onDone: () => void }) {
  const { t, fmt, pick } = useI18n();
  const toast = useToast();
  const r = item.rubric;
  const [values, setValues] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const complete = r.components.every((c) => values[c.key] !== undefined && values[c.key] !== '' && Number.isFinite(Number(values[c.key])));

  const send = async (decision: JudgeReviewRequest['decision']) => {
    setBusy(decision);
    try {
      const components = decision === 'score' ? Object.fromEntries(r.components.map((c) => [c.key, Number(values[c.key])])) : undefined;
      const res = await api.judgeReview(item.submissionId, { decision, components, notes: notes.trim() || undefined, evidence: [] });
      toast.show(t.challenges.outcomes[res.outcome], { tone: 'success' });
      onDone();
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const checkName = (k: string) => (t.challenges.checkNames as Record<string, string>)[k] ?? k;
  return (
    <section className="card stack" aria-label={pick(item.challenge.title)}>
      <div className="row row--between">
        <strong>{pick(item.challenge.title)}</strong>
        <span className="small muted">{fmt(t.challenges.round, { n: item.round, have: item.reviewsThisRound, need: item.judgesNeeded })}</span>
      </div>
      {item.flags.length ? <div className="row">{item.flags.map((f) => <span key={f} className="badge badge--outline">{t.challenges.flags[f]}</span>)}</div> : null}
      {item.video.playbackUrl ? (
        <video src={item.video.playbackUrl} poster={item.video.thumbnailUrl ?? undefined} controls playsInline preload="metadata"
          style={{ inlineSize: '100%', maxBlockSize: '70vh', background: '#000', borderRadius: '0.75rem' }} />
      ) : <p className="notice">{t.errors.genericText}</p>}
      <p className="small" dir="auto">{pick(r.summary)}</p>
      {item.claimedValue !== null ? <p className="small muted">{fmt(t.challenges.claim, { value: item.claimedValue })}</p> : null}
      {item.checks.length ? (
        <div>
          <h3 className="field__label">{t.challenges.checks}</h3>
          <ul className="list">
            {item.checks.map((c) => (
              <li key={c.key} className="list__row">
                <span>{checkName(c.key)}</span>
                <span className={`badge ${c.pass === true ? 'badge--green' : 'badge--outline'}`}>{c.pass === null ? t.challenges.checkUnknown : c.pass ? t.challenges.checkPass : t.challenges.checkFail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="form-grid">
        {r.components.map((c) => (
          <label key={c.key} className="field">
            <span className="field__label" dir="auto">{pick(c.label)} (0–{c.max})</span>
            <input className="input" type="number" inputMode="decimal" min={0} max={c.max} step="any" value={values[c.key] ?? ''}
              onChange={(e) => setValues({ ...values, [c.key]: e.target.value })} />
          </label>
        ))}
      </div>
      <label className="field">
        <span className="field__label">{t.challenges.judgeNotes}</span>
        <textarea className="input" rows={2} maxLength={1000} dir="auto" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="cta-row">
        <Button variant="primary" loading={busy === 'score'} disabled={!complete || busy !== null} onClick={() => send('score')}>{t.challenges.submitScore}</Button>
        <Button loading={busy === 'escalate'} disabled={notes.trim().length < 5 || busy !== null} onClick={() => send('escalate')}>{t.challenges.escalate}</Button>
        <Button variant="ghost" loading={busy === 'disqualify'} disabled={notes.trim().length < 5 || busy !== null} onClick={() => send('disqualify')}>{t.challenges.disqualify}</Button>
      </div>
    </section>
  );
}
