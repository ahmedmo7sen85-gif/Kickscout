'use client';

import type { ReactNode } from 'react';
import type { PitchPoint, PlayArrow } from '@/lib/types';

/**
 * A vertical football pitch drawn in SVG. Coordinates arrive as 0..100 on both axes (y 0 is the
 * goal the player attacks); the length is stretched to keep real pitch proportions. The pitch
 * never mirrors in right-to-left languages: attacking upwards reads the same in Arabic.
 */
export const PITCH_W = 100;
export const PITCH_H = 140;
export const sy = (y: number) => (y / 100) * PITCH_H;

/**
 * The part of the pitch worth showing for these points (0..100 on y), at least `minSpan` long, so
 * phones see the action large instead of a whole pitch with everyone in one half.
 */
export function focusRange(ys: number[], minSpan = 60): [number, number] {
  if (!ys.length) return [0, 100];
  let y0 = Math.max(0, Math.min(...ys) - 10);
  let y1 = Math.min(100, Math.max(...ys) + 10);
  if (y1 - y0 < minSpan) {
    const grow = (minSpan - (y1 - y0)) / 2;
    y0 = Math.max(0, y0 - grow);
    y1 = Math.min(100, y1 + grow);
    if (y1 - y0 < minSpan) (y0 === 0 ? (y1 = minSpan) : (y0 = 100 - minSpan));
  }
  return [y0, y1];
}

export function PitchFrame({ label, children, focus = [0, 100] }: { label: string; children: ReactNode; focus?: [number, number] }) {
  const top = sy(focus[0]) - 3;
  const height = sy(focus[1]) - sy(focus[0]) + 6;
  return (
    <svg className="pitch" viewBox={`-3 ${top} ${PITCH_W + 6} ${height}`} role="img" aria-label={label} direction="ltr">
      <rect x={-3} y={-3} width={PITCH_W + 6} height={PITCH_H + 6} className="pitch__grass" />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => <rect key={i} x={0} y={i * 20} width={PITCH_W} height={10} className="pitch__stripe" />)}
      <g className="pitch__lines">
        <rect x={0} y={0} width={PITCH_W} height={PITCH_H} />
        <line x1={0} y1={PITCH_H / 2} x2={PITCH_W} y2={PITCH_H / 2} />
        <circle cx={50} cy={PITCH_H / 2} r={13.5} />
        {/* penalty and goal areas, both ends */}
        <rect x={20.4} y={0} width={59.2} height={22} />
        <rect x={36.5} y={0} width={27} height={7.3} />
        <rect x={20.4} y={PITCH_H - 22} width={59.2} height={22} />
        <rect x={36.5} y={PITCH_H - 7.3} width={27} height={7.3} />
        <rect x={44.6} y={-2} width={10.8} height={2} className="pitch__goal" />
        <rect x={44.6} y={PITCH_H} width={10.8} height={2} className="pitch__goal" />
      </g>
      {children}
    </svg>
  );
}

const LETTERS = 'ABCDEFGH';
export const optionLetter = (i: number) => LETTERS[i] ?? String(i + 1);

export type ArrowTone = 'idle' | 'best' | 'chosen-wrong' | 'dim';

export function Arrow({ arrow, letter, tone, id }: { arrow: PlayArrow; letter: string; tone: ArrowTone; id: string }) {
  const x1 = arrow.from.x; const y1 = sy(arrow.from.y); const x2 = arrow.to.x; const y2 = sy(arrow.to.y);
  // Stop short of the target so the head does not cover the player.
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ex = x2 - ((x2 - x1) / len) * 2.6; const ey = y2 - ((y2 - y1) / len) * 2.6;
  const dash = arrow.kind === 'run' ? '2 1.6' : arrow.kind === 'dribble' ? '0.6 1.2' : undefined;
  const mx = x1 + (ex - x1) * 0.55; const my = y1 + (ey - y1) * 0.55;
  return (
    <g className={`pitch__arrow pitch__arrow--${tone} pitch__arrow--${arrow.kind}`}>
      <line x1={x1} y1={y1} x2={ex} y2={ey} strokeDasharray={dash} markerEnd={`url(#${id}-${tone})`} />
      <circle cx={mx} cy={my} r={2.4} className="pitch__tag" />
      <text x={mx} y={my + 0.05} className="pitch__tag-text">{letter}</text>
    </g>
  );
}

export function ArrowMarkers({ id }: { id: string }) {
  return (
    <defs>
      {(['idle', 'best', 'chosen-wrong', 'dim'] as const).map((tone) => (
        <marker key={tone} id={`${id}-${tone}`} viewBox="0 0 6 6" refX={3} refY={3} markerWidth={4} markerHeight={4} orient="auto-start-reverse">
          <path d="M0 0 6 3 0 6z" className={`pitch__head pitch__head--${tone}`} />
        </marker>
      ))}
    </defs>
  );
}

export function Dot({ p, kind, n, ring }: { p: PitchPoint; kind: 'team' | 'opp' | 'you' | 'neutral'; n?: string; ring?: boolean }) {
  const cy = sy(p.y);
  return (
    <g className={`pitch__player pitch__player--${kind}`}>
      {ring ? <circle cx={p.x} cy={cy} r={4.4} className="pitch__ring" /> : null}
      <circle cx={p.x} cy={cy} r={2.7} />
      {n ? <text x={p.x} y={cy + 0.05} className="pitch__num">{n}</text> : null}
    </g>
  );
}

export function Ball({ p }: { p: PitchPoint }) {
  return <circle cx={p.x} cy={sy(p.y)} r={1.3} className="pitch__ball" />;
}
