'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { PageHead, Section } from '@/components/PageHead';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { AdminMetrics, FunnelView, MetricPoint } from '@/lib/types';

const PERIODS = [7, 30, 90, 180] as const;

/** Product metrics for admins (the API also requires MFA). Every chart has a data-table equivalent. */
export function MetricsView() {
  const { t } = useI18n();
  return (
    <div className="wrap page" style={{ maxInlineSize: '90rem' }}>
      <PageHead title={t.metrics.title} intro={t.metrics.intro} kicker={<Link href="/admin">{t.admin.title}</Link>} />
      <AuthGate><Gate /></AuthGate>
    </div>
  );
}

function Gate() {
  const { t, fmt } = useI18n();
  const { isStaff } = useAuth();
  const [days, setDays] = useState<number>(30);
  const periodId = useId();
  const m = useApi((s) => api.adminMetrics({ days }, s), [days]);
  if (!isStaff) return <EmptyState icon="shield" title={t.admin.forbiddenTitle} text={t.admin.forbiddenText} />;
  return (
    <div className="stack stack--loose">
      <div className="field metrics__period">
        <label className="field__label" htmlFor={periodId}>{t.metrics.period}</label>
        <select id={periodId} className="input input--sm" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {PERIODS.map((d) => <option key={d} value={d}>{fmt(t.metrics.lastDays, { n: d })}</option>)}
        </select>
      </div>
      {m.status === 'loading' ? <Skeleton height="16rem" radius="0.9rem" /> : null}
      {m.status === 'error' ? <ErrorState error={m.error} onRetry={m.retry} /> : null}
      {m.status === 'success' ? <MetricsReport data={m.data} /> : null}
    </div>
  );
}

/** The whole report for one response. Pure: rendered in tests without the API. */
export function MetricsReport({ data }: { data: AdminMetrics }) {
  const { t, fmt, formatNumber, formatDate } = useI18n();
  const series: [string, string, MetricPoint[]][] = [
    ['dau', t.metrics.dau, data.dau],
    ['wau', t.metrics.wau, data.wau],
    ['uploads', t.metrics.uploads, data.uploads],
    ['publishes', t.metrics.publishes, data.publishes],
    ['scoutSearches', t.metrics.scoutSearches, data.scoutSearches],
    ['contactRequests', t.metrics.contactRequests, data.contactRequests],
  ];
  return (
    <div className="stack stack--loose">
      <p className="muted small" role="status">
        {data.lastRolledDay ? fmt(t.metrics.dataUntil, { date: formatDate(data.lastRolledDay) }) : t.metrics.noRollup}
      </p>
      <Section title={t.metrics.northStar} id="m-north-star">
        <p>{t.metrics.northStarText}</p>
        <p className="metrics__total"><strong>{fmt(t.metrics.total, { n: formatNumber(data.northStar.total) })}</strong></p>
        <BarChart label={t.metrics.northStar} points={data.northStar.series} accent />
        <details className="metrics__definition">
          <summary>{t.metrics.definition}</summary>
          <p lang="en">{data.northStar.definition}</p>
        </details>
      </Section>
      <div className="metrics__grid">
        {series.map(([key, label, points]) => (
          <Section key={key} title={label} id={`m-${key}`}>
            <BarChart label={label} points={points} />
          </Section>
        ))}
      </div>
      <Section title={t.metrics.funnels} id="m-funnels">
        <p className="muted small">{t.metrics.funnelsIntro}</p>
        <div className="metrics__grid">{data.funnels.map((f) => <Funnel key={f.key} funnel={f} />)}</div>
      </Section>
      <p className="muted small">{t.metrics.privacyNote}</p>
    </div>
  );
}

/** An SVG bar chart summarised in its accessible name, with the full numbers in a table below. */
export function BarChart({ label, points, accent = false }: { label: string; points: MetricPoint[]; accent?: boolean }) {
  const { t, fmt, formatDate } = useI18n();
  const max = Math.max(0, ...points.map((p) => p.value));
  const total = points.reduce((a, p) => a + p.value, 0);
  const w = 100;
  const h = 40;
  const bw = points.length ? w / points.length : w;
  const summary = fmt(t.metrics.chartLabel, {
    label,
    from: points[0] ? formatDate(points[0].day) : '',
    to: points.at(-1) ? formatDate(points.at(-1)!.day) : '',
    total,
    max,
  });
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={summary} className={accent ? 'chart__svg chart__svg--accent' : 'chart__svg'}>
        <line x1="0" y1={h - 0.25} x2={w} y2={h - 0.25} className="chart__axis" />
        {points.map((p, i) => {
          const bh = max ? (p.value / max) * (h - 2) : 0;
          return <rect key={p.day} x={i * bw + bw * 0.1} y={h - bh} width={bw * 0.8} height={bh} className="chart__bar" />;
        })}
      </svg>
      <details className="chart__table">
        <summary>{t.metrics.tableToggle}</summary>
        <table>
          <caption className="sr-only">{label}</caption>
          <thead><tr><th scope="col">{t.metrics.colDay}</th><th scope="col">{t.metrics.colValue}</th></tr></thead>
          <tbody>
            {points.map((p) => <tr key={p.day}><th scope="row">{formatDate(p.day)}</th><td>{p.value}</td></tr>)}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function Funnel({ funnel }: { funnel: FunnelView }) {
  const { t, formatNumber } = useI18n();
  const title = t.metrics[`funnel_${funnel.key}`];
  const stepLabel = (event: string) => (t.metrics as Record<string, string>)[`step_${event}`] ?? event;
  return (
    <table className="funnel">
      <caption>{title}</caption>
      <thead><tr><th scope="col">{t.metrics.colStep}</th><th scope="col">{t.metrics.colUsers}</th><th scope="col">{t.metrics.colRate}</th></tr></thead>
      <tbody>
        {funnel.steps.map((s, i) => {
          const prev = i > 0 ? funnel.steps[i - 1]!.users : null;
          const rate = prev === null ? '' : prev === 0 ? '–' : `${Math.round((s.users / prev) * 100)}%`;
          return <tr key={s.event}><th scope="row">{stepLabel(s.event)}</th><td>{formatNumber(s.users)}</td><td>{rate}</td></tr>;
        })}
      </tbody>
    </table>
  );
}
