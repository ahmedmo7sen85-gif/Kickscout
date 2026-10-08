'use client';

import { useEffect, useRef, useState } from 'react';
import { AiBadge } from '@/components/ui/Badge';
import { useReducedMotion } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n/provider';
import { promoClip, promoPosterUrl, promoVideoUrl, type PromoStem } from '@/lib/promo';

/** Drawn stand-in shown while a promo file is missing: chalk pitch lines and a ball path. */
export function PitchPlaceholder({ seed = 0, wide = false }: { seed?: number; wide?: boolean }) {
  const paths = [
    'M20 140 C 80 120, 20 90, 80 40',
    'M20 120 Q 50 20, 80 120',
    'M80 130 L 45 100 L 80 70',
    'M15 110 C 40 70, 60 140, 85 90',
  ];
  return (
    <svg viewBox={wide ? '0 0 178 100' : '0 0 100 178'} preserveAspectRatio="xMidYMid slice" aria-hidden="true" className="pitch-ph">
      <rect width="100%" height="100%" fill="#0d1117" />
      {wide ? (
        <g fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="0.8">
          <line x1="110" y1="0" x2="110" y2="100" />
          <circle cx="110" cy="50" r="22" />
        </g>
      ) : (
        <g fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="0.8">
          <rect x="8" y="9" width="84" height="160" />
          <line x1="8" y1="89" x2="92" y2="89" />
          <circle cx="50" cy="89" r="20" />
        </g>
      )}
      <path d={wide ? 'M100 75 C 125 30, 140 80, 165 35' : paths[seed % 4]} fill="none" stroke="rgba(183,255,0,0.75)" strokeWidth="1.4" strokeDasharray="3 3.5" />
      <circle cx={wide ? 128 : 50} cy={wide ? 52 : 72} r={wide ? 4 : 4.5} fill="#fff" />
    </svg>
  );
}

/**
 * One AI-generated promo clip: poster first, video only once it is near the screen, and the drawn
 * placeholder if either file is missing. Always labelled AI-generated; never presented as a player.
 */
export function PromoClip({ stem, caption, seed = 0, showNumber = true }: { stem: PromoStem; caption?: string; seed?: number; showNumber?: boolean }) {
  const { t, fmt, pick } = useI18n();
  const clip = promoClip(stem);
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [posterOk, setPosterOk] = useState(true);
  const [posterLoaded, setPosterLoaded] = useState(false);
  const [videoOk, setVideoOk] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [near, setNear] = useState(false);
  const [inView, setInView] = useState(false);
  const name = pick(clip.label);

  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e) return;
      if (e.isIntersecting) setNear(true);
      setInView(e.intersectionRatio >= 0.4);
    }, { rootMargin: '200px 0px', threshold: [0, 0.4] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoOk) return;
    if (inView && !reduced) v.play().catch(() => {}); else v.pause();
  }, [inView, reduced, videoOk]);

  return (
    <div ref={ref} className="frame">
      <PitchPlaceholder seed={seed} />
      {posterOk ? <img ref={(el) => { if (el?.complete && el.naturalWidth > 0) setPosterLoaded(true); }} src={promoPosterUrl(stem)} alt="" loading="lazy" onLoad={() => setPosterLoaded(true)} onError={() => setPosterOk(false)} hidden={videoOk} style={{ opacity: posterLoaded ? 1 : 0 }} /> : null}
      {near && !reduced && !videoFailed ? (
        <video
          ref={videoRef}
          src={promoVideoUrl(stem)}
          muted
          loop
          playsInline
          preload="metadata"
          aria-label={fmt(t.landing.clipLabel, { name })}
          hidden={!videoOk}
          onLoadedData={() => setVideoOk(true)}
          onError={() => setVideoFailed(true)}
        />
      ) : null}
      <span className="frame__chip"><AiBadge /></span>
      {showNumber ? <span className="frame__num" aria-hidden="true">{clip.n}</span> : null}
      <div className="frame__over">
        <b>{name}</b>
        <small>{caption ?? `#${pick(clip.category).replace(/\s/g, '')}`}</small>
      </div>
    </div>
  );
}
