'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { TRAINING_DRILLS, type TrainingDrill } from '@fp/domain';
import { AuthGate } from '@/components/AuthGate';
import { PageHead } from '@/components/PageHead';
import { XpCard } from '@/components/play/XpCard';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { PlayProfile } from '@/lib/types';

export function DrillsView() {
  const { t } = useI18n();
  return (
    <div className="wrap wrap--mid page">
      <div className="row">
        <Link href="/play" className="back-link"><Icon name="arrow" size={16} className="back-link__icon" />{t.play.backToPlay}</Link>
      </div>
      <PageHead title={t.play.drillsTitle} intro={t.play.drillsIntro} />
      <AuthGate><Drills /></AuthGate>
    </div>
  );
}

function Drills() {
  const { t, fmt, pick } = useI18n();
  const me = useApi((s) => api.playMe(s), []);
  const [open, setOpen] = useState<string | null>(null);

  if (me.status === 'loading') return <SkeletonList rows={4} label={t.common.loading} />;
  if (me.status === 'error') return <ErrorState error={me.error} title={t.play.loadError} onRetry={me.retry} />;
  const done = new Set(me.data.today.drillsDone);

  return (
    <div className="stack stack--loose">
      <XpCard profile={me.data} compact />
      <div className="stack">
        {TRAINING_DRILLS.map((d) => (
          <section key={d.key} className={`drill card${open === d.key ? ' is-open' : ''}`} aria-labelledby={`drill-${d.key}`}>
            <button type="button" className="drill__head" onClick={() => setOpen(open === d.key ? null : d.key)} aria-expanded={open === d.key}>
              <span className="stack stack--tight">
                <span className="drill__title" id={`drill-${d.key}`}>{pick(d.title)}</span>
                <span className="row muted drill__meta">
                  <span>{fmt(t.play.minutes, { n: Math.round(d.seconds / 60) })}</span>
                  <span>{fmt(t.play.xpGained, { n: d.xp })}</span>
                </span>
              </span>
              {done.has(d.key) ? <span className="badge badge--green"><Icon name="check" size={12} />{t.play.doneToday}</span> : <span className="badge badge--outline">{t.play.openDrill}</span>}
            </button>
            {open === d.key ? (
              <DrillBody drill={d} done={done.has(d.key)} onLogged={(p) => me.setData(() => p)} />
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

function DrillBody({ drill, done, onLogged }: { drill: TrainingDrill; done: boolean; onLogged: (p: PlayProfile) => void }) {
  const { t, fmt, pick } = useI18n();
  const toast = useToast();
  const [left, setLeft] = useState(drill.seconds);
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState('');
  const [busy, setBusy] = useState(false);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!running) return;
    tick.current = setInterval(() => setLeft((s) => {
      if (s <= 1) { setRunning(false); return 0; }
      return s - 1;
    }), 1000);
    return () => { if (tick.current) clearInterval(tick.current); };
  }, [running]);

  const log = async () => {
    setBusy(true);
    try {
      const n = Number.parseInt(count, 10);
      const res = await api.logDrill(drill.key, Number.isFinite(n) && n >= 0 ? { count: Math.min(n, 10_000) } : {});
      onLogged(res.profile);
      toast.show(res.xpAwarded ? fmt(t.play.drillLogged, { n: res.xpAwarded }) : t.play.drillAlready, { tone: 'success' });
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <div className="drill__body stack">
      <div className="stack stack--tight">
        <span className="kicker">{t.play.stepsLabel}</span>
        <ol className="steps">{drill.steps.map((s, i) => <li key={i}>{pick(s)}</li>)}</ol>
      </div>
      <div className="notice">
        <span className="kicker">{t.play.whyLabel}</span>
        <p>{pick(drill.why)}</p>
      </div>
      <div className="drill__timer">
        <span className="drill__clock" aria-live="off" dir="ltr">{mm}:{ss}</span>
        <div className="row">
          {!running && left === drill.seconds ? <Button variant="primary" onClick={() => setRunning(true)}>{t.play.startTimer}</Button> : null}
          {running ? <Button onClick={() => setRunning(false)}>{t.play.pause}</Button> : null}
          {!running && left > 0 && left < drill.seconds ? <Button variant="primary" onClick={() => setRunning(true)}>{t.play.resume}</Button> : null}
          {left !== drill.seconds ? <Button variant="ghost" onClick={() => { setRunning(false); setLeft(drill.seconds); }}>{t.play.reset}</Button> : null}
        </div>
      </div>
      {left === 0 ? <p className="drill__timeup" role="status">{t.play.timeUp}</p> : null}
      <div className="row drill__log">
        {drill.countLabel ? (
          <label className="field drill__count">
            <span className="field__label">{fmt(t.play.countOptional, { label: pick(drill.countLabel) })}</span>
            <input className="input" type="number" inputMode="numeric" min={0} max={10000} value={count} onChange={(e) => setCount(e.target.value)} />
          </label>
        ) : null}
        <Button variant={done ? 'secondary' : 'primary'} onClick={() => void log()} loading={busy}>{t.play.logDrill}</Button>
      </div>
    </div>
  );
}
