'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { SCAN_REPS } from '@fp/domain';
import { AuthGate } from '@/components/AuthGate';
import { PageHead } from '@/components/PageHead';
import { XpCard } from '@/components/play/XpCard';
import { Dot, PitchFrame, sy } from '@/components/play/Pitch';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import type { PitchPoint, PlayXpAward } from '@/lib/types';

/** One scanning picture: teammates, opponents, and which teammate is free. */
export interface ScanPicture { you: PitchPoint; team: PitchPoint[]; opp: PitchPoint[]; free: number }

const dist = (a: PitchPoint, b: PitchPoint) => Math.hypot(a.x - b.x, sy(a.y) - sy(b.y));

/**
 * Builds a picture with exactly one free teammate: every other teammate has an opponent within
 * 7 units, and the free one has none within 18. Pure apart from `random`, so it can be tested.
 */
export function makeScanPicture(random: () => number = Math.random, teammates = 4): ScanPicture {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const team: PitchPoint[] = [];
    while (team.length < teammates) {
      const p = { x: 10 + random() * 80, y: 14 + random() * 52 };
      if (team.every((q) => dist(p, q) > 20)) team.push(p);
    }
    const free = Math.floor(random() * teammates);
    const opp: PitchPoint[] = team.flatMap((p, i) => {
      if (i === free) return [];
      const a = random() * Math.PI * 2;
      return [{ x: Math.min(97, Math.max(3, p.x + Math.cos(a) * 4.5)), y: Math.min(97, Math.max(3, p.y + (Math.sin(a) * 4.5 * 100) / 140)) }];
    });
    // Two extra opponents away from the free player, so position alone does not give it away.
    for (let k = 0; k < 2; k += 1) opp.push({ x: 8 + random() * 84, y: 10 + random() * 60 });
    const markedOk = team.every((p, i) => i === free || opp.some((o) => dist(o, p) < 7));
    const freeOk = opp.every((o) => dist(o, team[free]!) > 18);
    if (markedOk && freeOk) return { you: { x: 50, y: 86 }, team, opp, free };
  }
  // Practically unreachable; a fixed, valid picture keeps the drill going.
  return { you: { x: 50, y: 86 }, team: [{ x: 20, y: 30 }, { x: 80, y: 30 }, { x: 50, y: 50 }, { x: 30, y: 60 }],
    opp: [{ x: 23, y: 32 }, { x: 52, y: 52 }, { x: 33, y: 62 }, { x: 15, y: 70 }], free: 1 };
}

type Phase = 'intro' | 'flash' | 'pick' | 'reveal' | 'done';

export function ScanView() {
  const { t } = useI18n();
  return (
    <div className="wrap wrap--mid page">
      <div className="row">
        <Link href="/play" className="back-link"><Icon name="arrow" size={16} className="back-link__icon" />{t.play.backToPlay}</Link>
      </div>
      <PageHead title={t.play.scanTitle} intro={t.play.scanIntro} />
      <AuthGate><Drill /></AuthGate>
    </div>
  );
}

function Drill() {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('intro');
  const [rep, setRep] = useState(0);
  const [hits, setHits] = useState(0);
  const [flashMs, setFlashMs] = useState(1500);
  const [pic, setPic] = useState<ScanPicture | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [award, setAward] = useState<PlayXpAward | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const startRep = (n: number, ms: number) => {
    setRep(n);
    setPicked(null);
    setPic(makeScanPicture());
    setPhase('flash');
    timer.current = setTimeout(() => setPhase('pick'), ms);
  };
  const start = () => {
    setHits(0);
    setAward(null);
    setFlashMs(1500);
    startRep(1, 1500);
  };
  const finish = async (total: number) => {
    setPhase('done');
    try {
      setAward(await api.logScan({ hits: total, reps: SCAN_REPS as 10 }));
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    }
  };
  const pickPlayer = (i: number) => {
    if (phase !== 'pick' || !pic) return;
    const right = i === pic.free;
    const total = hits + (right ? 1 : 0);
    const ms = right ? Math.max(500, flashMs - 120) : Math.min(1800, flashMs + 120);
    setPicked(i);
    setHits(total);
    setFlashMs(ms);
    setPhase('reveal');
    timer.current = setTimeout(() => (rep >= SCAN_REPS ? void finish(total) : startRep(rep + 1, ms)), 1100);
  };

  if (phase === 'intro') {
    return (
      <div className="card stack">
        <ol className="steps">
          <li>{t.play.scanStep1}</li>
          <li>{t.play.scanStep2}</li>
          <li>{t.play.scanStep3}</li>
        </ol>
        <Button variant="primary" size="lg" onClick={start}>{t.play.start}</Button>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="stack stack--loose">
        <div className="card round-summary">
          <span className="kicker">{t.play.scanDone}</span>
          <div className="round-summary__score">{fmt(t.play.scanScore, { hits, total: SCAN_REPS })}</div>
          {award?.xpAwarded ? <span className="badge badge--green">{fmt(t.play.xpGained, { n: award.xpAwarded })}</span> : null}
          {award?.capped ? <p className="muted">{t.play.scanCapped}</p> : null}
          <div className="row">
            <Button variant="primary" onClick={start}>{t.play.playAgain}</Button>
            <ButtonLink href="/play" variant="secondary">{t.play.backToPlay}</ButtonLink>
          </div>
        </div>
        {award ? <XpCard profile={award.profile} /> : null}
      </div>
    );
  }

  const showColours = phase === 'flash';
  const right = picked !== null && pic !== null && picked === pic.free;
  return (
    <div className="scan">
      <div className="row row--between">
        <span className="kicker">{fmt(t.play.scanRep, { n: rep, total: SCAN_REPS })}</span>
        <span className="badge badge--outline">{hits} / {rep - (phase === 'reveal' ? 0 : 1)}</span>
      </div>
      <p className={`scan__cue${phase === 'reveal' ? (right ? ' is-right' : ' is-wrong') : ''}`} role="status" aria-live="polite">
        {phase === 'flash' ? t.play.scanLook : phase === 'pick' ? t.play.scanTap : right ? t.play.scanRight : t.play.scanWrong}
      </p>
      {pic ? (
        <div className="scan__pitch" dir="ltr">
          <PitchFrame label={t.play.pitchLabel}>
            {pic.opp.map((p, i) => (showColours || phase === 'reveal'
              ? <Dot key={`o${i}`} p={p} kind="opp" />
              : <Dot key={`o${i}`} p={p} kind="neutral" />))}
            {pic.team.map((p, i) => (
              <g key={`t${i}`}>
                <Dot p={p} kind={showColours || phase === 'reveal' ? 'team' : 'neutral'} ring={phase === 'reveal' && i === pic.free} />
                {phase === 'reveal' && picked === i && i !== pic.free ? <circle cx={p.x} cy={sy(p.y)} r={4.4} className="pitch__miss" /> : null}
              </g>
            ))}
            <Dot p={pic.you} kind="you" />
          </PitchFrame>
          {phase === 'pick' ? (
            // Real buttons over every player, in the same positions, so keyboards and screen readers can answer too.
            <div className="scan__targets">
              {[...pic.team.map((p, i) => ({ p, i })), ...pic.opp.map((p, j) => ({ p, i: pic.team.length + j }))]
                .sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x)
                .map(({ p, i }, k) => (
                  <button key={i} type="button" className="scan__target" aria-label={fmt(t.play.scanPlayer, { n: k + 1 })}
                    style={{ left: `${((p.x + 3) / 106) * 100}%`, top: `${((sy(p.y) + 3) / 146) * 100}%` }}
                    onClick={() => pickPlayer(i)} />
                ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
