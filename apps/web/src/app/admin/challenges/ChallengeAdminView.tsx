'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { PageHead, Section } from '@/components/PageHead';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import type { AdminChallengeView, ChallengeTransitionRequest } from '@/lib/types';
import { useApi } from '@/lib/useApi';

type Action = ChallengeTransitionRequest['action'];

/** Which actions make sense from each status. The API checks again (packages/domain adminTransition). */
const ACTIONS: Record<AdminChallengeView['status'], Action[]> = {
  draft: ['publish', 'cancel'],
  scheduled: ['pause', 'cancel'],
  active: ['pause', 'close', 'cancel'],
  paused: ['resume', 'cancel'],
  judging: ['complete', 'cancel'],
  completed: ['archive'],
  cancelled: ['archive'],
  archived: [],
};

/** Challenge manager for staff: templates, drafts, publishing, judges, appeals and health metrics. Every action is audited by the API. */
export function ChallengeAdminView() {
  const { t } = useI18n();
  return (
    <div className="wrap page" style={{ maxInlineSize: '90rem' }}>
      <PageHead title={t.challenges.adminTitle} actions={<Link className="link" href="/judge">{t.challenges.judgeQueueLink}</Link>} />
      <AuthGate><Gate /></AuthGate>
    </div>
  );
}

function Gate() {
  const { t } = useI18n();
  const { isStaff } = useAuth();
  const list = useApi((s) => api.adminChallenges({}, s), [], { enabled: isStaff });
  const templates = useApi((s) => api.adminChallenges({ templates: true }, s), [], { enabled: isStaff });
  if (!isStaff) return <EmptyState icon="shield" title={t.admin.forbiddenTitle} text={t.admin.forbiddenText} />;
  const reload = () => { list.retry(); templates.retry(); };
  return (
    <div className="stack stack--loose">
      <Create templates={templates.status === 'success' ? templates.data.items : []} onCreated={reload} />
      <Section title={t.challenges.title} id="ac-list">
        {list.status === 'loading' ? <SkeletonList rows={4} label={t.common.loading} /> : null}
        {list.status === 'error' ? <ErrorState error={list.error} onRetry={list.retry} /> : null}
        {list.status === 'success' && !list.data.items.length ? <p className="muted">{t.challenges.empty}</p> : null}
        {list.status === 'success' ? <div className="stack">{list.data.items.map((c) => <ChallengeRow key={c.id} c={c} onChange={list.retry} />)}</div> : null}
      </Section>
      <Appeals />
      <Metrics />
    </div>
  );
}

function Create({ templates, onCreated }: { templates: AdminChallengeView[]; onCreated: () => void }) {
  const { t, fmt, pick } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ template: '', slug: '', startsAt: '', endsAt: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const install = async () => {
    setBusy(true);
    try {
      const r = await api.installChallengeTemplates();
      toast.show(fmt(t.challenges.templatesInstalled, { n: r.installed.length }), { tone: 'success' });
      onCreated();
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createChallenge({ fromTemplate: f.template, slug: f.slug.trim(), startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString() });
      toast.show(t.challenges.created, { tone: 'success' });
      setF({ template: '', slug: '', startsAt: '', endsAt: '' });
      onCreated();
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(false); }
  };

  return (
    <Section title={t.challenges.createDraft} id="ac-create" action={<Button size="sm" loading={busy} onClick={install}>{t.challenges.installTemplates}</Button>}>
      <form className="card" onSubmit={create}>
        <div className="form-grid">
          <label className="field"><span className="field__label">{t.challenges.fromTemplate}</span>
            <select className="input" required value={f.template} onChange={set('template')}>
              <option value="" />
              {templates.map((x) => <option key={x.id} value={x.slug}>{pick(x.title)}</option>)}
            </select>
          </label>
          <label className="field"><span className="field__label">{t.challenges.slug}</span><input className="input" required pattern="[a-z0-9-]{3,60}" value={f.slug} onChange={set('slug')} /></label>
          <label className="field"><span className="field__label">{t.challenges.startsAt}</span><input className="input" type="datetime-local" required value={f.startsAt} onChange={set('startsAt')} /></label>
          <label className="field"><span className="field__label">{t.challenges.endsAt}</span><input className="input" type="datetime-local" required value={f.endsAt} onChange={set('endsAt')} /></label>
        </div>
        <div><Button type="submit" variant="primary" loading={busy} disabled={!templates.length}>{t.challenges.createDraft}</Button></div>
      </form>
    </Section>
  );
}

function ChallengeRow({ c, onChange }: { c: AdminChallengeView; onChange: () => void }) {
  const { t, pick, formatDate, formatNumber } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [judges, setJudges] = useState(c.judges.map((j) => j.userId).join(', '));

  const act = async (action: Action) => {
    setBusy(action);
    try {
      await api.transitionChallenge(c.id, { action, force: action === 'complete' ? force : false });
      toast.show(t.challenges.saved, { tone: 'success' });
      onChange();
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  const saveJudges = async () => {
    setBusy('judges');
    try {
      await api.setChallengeJudges(c.id, judges.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean));
      toast.show(t.challenges.saved, { tone: 'success' });
      onChange();
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(null); }
  };

  const counts = Object.entries(c.counts).filter(([, n]) => n > 0);
  return (
    <details className="card card--outline">
      <summary className="row row--between" style={{ cursor: 'pointer' }}>
        <span className="row">
          <span className={`badge ${c.status === 'active' ? 'badge--green' : 'badge--outline'}`}>{c.status}</span>
          <strong>{pick(c.title)}</strong>
          <span className="small muted mono">{c.slug}</span>
        </span>
        <span className="small muted">{formatDate(c.startsAt)} – {formatDate(c.endsAt)}{c.openAppeals ? ` · ${t.challenges.openAppeals}: ${c.openAppeals}` : ''}</span>
      </summary>
      <div className="stack" style={{ marginBlockStart: '0.75rem' }}>
        <div className="row">
          <Link className="link" href={`/challenges/${c.slug}`}>/challenges/{c.slug}</Link>
          {c.rubricVersions.map((v) => <span key={v.id} className="badge badge--outline">v{v.version} {v.method}{v.frozen ? ' 🔒' : ''}{v.current ? ' ✓' : ''}</span>)}
        </div>
        {counts.length ? (
          <p className="small"><span className="field__label">{t.challenges.entriesByState}: </span>
            {counts.map(([k, n]) => `${t.challenges.states[k as keyof typeof t.challenges.states]} ${formatNumber(n)}`).join(' · ')}</p>
        ) : null}
        <div className="cta-row">
          {ACTIONS[c.status].map((a) => <Button key={a} size="sm" variant={a === 'publish' || a === 'complete' ? 'primary' : 'secondary'} loading={busy === a} disabled={busy !== null} onClick={() => act(a)}>{t.challenges.actions[a]}</Button>)}
        </div>
        {c.status === 'judging' ? (
          <label className={`check-row${force ? ' is-checked' : ''}`}><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /><span>{t.challenges.forceComplete}</span></label>
        ) : null}
        <label className="field">
          <span className="field__label">{t.challenges.judgesLabel}</span>
          <input className="input mono" value={judges} onChange={(e) => setJudges(e.target.value)} />
          {c.judges.length ? <span className="field__hint">{c.judges.map((j) => `@${j.handle}`).join(', ')}</span> : null}
        </label>
        <div><Button size="sm" loading={busy === 'judges'} disabled={busy !== null} onClick={saveJudges}>{t.challenges.saveJudges}</Button></div>
      </div>
    </details>
  );
}

function Appeals() {
  const { t, pick } = useI18n();
  const toast = useToast();
  const a = useApi((s) => api.challengeAppeals(s), []);
  const [text, setText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const resolve = async (id: string, decision: 'uphold' | 'reject', reinstate: boolean) => {
    setBusy(id);
    try {
      await api.resolveAppeal(id, { decision, resolution: (text[id] ?? '').trim(), reinstate: decision === 'uphold' ? reinstate : undefined });
      toast.show(t.challenges.saved, { tone: 'success' });
      a.retry();
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  return (
    <Section title={t.challenges.openAppeals} id="ac-appeals">
      {a.status === 'loading' ? <SkeletonList rows={3} label={t.common.loading} /> : null}
      {a.status === 'error' ? <ErrorState error={a.error} onRetry={a.retry} /> : null}
      {a.status === 'success' && !a.data.items.filter((x) => x.status === 'open').length ? <p className="muted">{t.challenges.judgeEmpty}</p> : null}
      {a.status === 'success' ? (
        <div className="stack">
          {a.data.items.filter((x) => x.status === 'open').map((x) => (
            <div key={x.id} className="card card--outline stack stack--tight">
              <span className="row"><strong>{pick(x.challenge.title)}</strong><span className="badge badge--outline">{t.challenges.states[x.state]}</span>
                <Link className="link small" href={`/v/${x.videoId}`}>{t.challenges.watchClip}</Link></span>
              <p dir="auto">{x.reason}</p>
              <label className="field"><span className="field__label">{t.challenges.resolution}</span>
                <textarea className="input" rows={2} maxLength={1000} dir="auto" value={text[x.id] ?? ''} onChange={(e) => setText({ ...text, [x.id]: e.target.value })} /></label>
              <div className="cta-row">
                <Button size="sm" variant="primary" loading={busy === x.id} disabled={(text[x.id] ?? '').trim().length < 5 || busy !== null}
                  onClick={() => resolve(x.id, 'uphold', x.state === 'disqualified')}>{t.challenges.uphold}</Button>
                <Button size="sm" disabled={(text[x.id] ?? '').trim().length < 5 || busy !== null} onClick={() => resolve(x.id, 'reject', false)}>{t.challenges.rejectAppeal}</Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function Metrics() {
  const { t, pick, formatNumber } = useI18n();
  const m = useApi((s) => api.challengeMetrics(s), []);
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
  return (
    <Section title={t.admin.metricsLink} id="ac-metrics">
      {m.status === 'loading' ? <SkeletonList rows={3} label={t.common.loading} /> : null}
      {m.status === 'error' ? <ErrorState error={m.error} onRetry={m.retry} /> : null}
      {m.status === 'success' ? (
        <div className="stack">
          <p className="small">stuck: {formatNumber(m.data.stuckSubmissions)} · backlog: {formatNumber(m.data.judgingBacklog)}</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th /><th>players</th><th>entries</th><th>approved</th><th>completion</th><th>rejected</th><th>appeals</th><th>disagree</th><th>votes</th><th>set aside</th><th>scout picks</th><th>shortlists</th><th>median h</th></tr></thead>
              <tbody>
                {m.data.challenges.map((c) => (
                  <tr key={c.challenge.id}>
                    <td>{pick(c.challenge.title)}</td><td>{c.participants}</td><td>{c.submissions}</td><td>{c.approved}</td><td>{pct(c.completionRate)}</td>
                    <td>{pct(c.moderationRejectionRate)}</td><td>{c.appeals}</td><td>{c.disagreements}</td><td>{c.eligibleVotes}</td><td>{c.setAsideVotes}</td>
                    <td>{c.scoutPicks}</td><td>{c.scoutShortlists}</td><td>{c.medianHoursToResult ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>agent</th><th>runs</th><th>errors</th><th>to human</th><th>flagged</th><th>avg ms</th><th>cost USD</th></tr></thead>
              <tbody>{m.data.agents.map((a) => <tr key={a.agent}><td className="mono">{a.agent}</td><td>{a.runs}</td><td>{a.errors}</td><td>{a.routedToHuman}</td><td>{a.flagged}</td><td>{a.avgLatencyMs === null ? '—' : Math.round(a.avgLatencyMs)}</td><td>{a.costUsd.toFixed(4)}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
