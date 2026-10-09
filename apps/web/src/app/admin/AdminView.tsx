'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { PageHead, Section } from '@/components/PageHead';
import { Button } from '@/components/ui/Button';
import { Skeleton, SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { normalizeHashtag, SKILL_KEYS } from '@/lib/constants';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { AiUsageView, ModerationCaseView, ModerationDecisionRequest, SkillKey } from '@/lib/types';

/** Upheld claims on this many distinct videos flag the owner as a repeat infringer (a prompt for review, not an automatic ban). */
const REPEAT_INFRINGER_STRIKES = 3;

/** Staff console. Hidden from non-staff as a convenience; the API enforces every permission. */
export function AdminView() {
  const { t } = useI18n();
  return (
    <div className="wrap page" style={{ maxInlineSize: '90rem' }}>
      <PageHead title={t.admin.title} />
      <AuthGate><Gate /></AuthGate>
    </div>
  );
}

function Gate() {
  const { t } = useI18n();
  const { isStaff } = useAuth();
  if (!isStaff) return <EmptyState icon="shield" title={t.admin.forbiddenTitle} text={t.admin.forbiddenText} />;
  return (
    <div className="stack stack--loose">
      <Stats />
      <Moderation />
      <AiUsage />
      <Verifications />
      <CreateChallenge />
      <Audit />
    </div>
  );
}

function Stats() {
  const { t, formatNumber } = useI18n();
  const s = useApi((sig) => api.adminStats(sig), []);
  const labels = [
    ['users', t.admin.users], ['players', t.admin.players], ['scouts', t.admin.scouts], ['videosPublished', t.admin.videosPublished],
    ['openCases', t.admin.openCases], ['pendingVerifications', t.admin.pendingVerifications], ['failedJobs', t.admin.failedJobs],
  ] as const;
  return (
    <Section title={t.admin.statsTitle} id="a-stats">
      {s.status === 'loading' ? <div className="stat-grid">{labels.map(([k]) => <Skeleton key={k} height="5rem" radius="0.9rem" />)}</div> : null}
      {s.status === 'error' ? <ErrorState error={s.error} onRetry={s.retry} /> : null}
      {s.status === 'success' ? (
        <div className="stat-grid">{labels.map(([k, l]) => <div key={k} className="stat"><strong>{formatNumber(s.data[k])}</strong><span>{l}</span></div>)}</div>
      ) : null}
    </Section>
  );
}

function AiUsage() {
  const { t, formatNumber } = useI18n();
  const u = useApi((s) => api.aiUsage(s), []);
  return (
    <Section title={t.aiAdmin.title} id="a-ai">
      {u.status === 'loading' ? <SkeletonList rows={2} label={t.common.loading} /> : null}
      {u.status === 'error' ? <ErrorState error={u.error} onRetry={u.retry} /> : null}
      {u.status === 'success' ? <AiUsageTable usage={u.data} formatNumber={formatNumber} /> : null}
    </Section>
  );
}

export function AiUsageTable({ usage, formatNumber }: { usage: AiUsageView; formatNumber: (n: number) => string }) {
  const { t } = useI18n();
  const a = t.aiAdmin;
  return (
    <div className="stack">
      {!usage.available ? <p className="muted small" role="note">{a.noKey}</p> : null}
      <ul className="list small">
        {usage.routes.map((r) => <li key={r.task} className="mono">{r.task}: {r.model} · {r.tier} · {r.effort}</li>)}
      </ul>
      {usage.items.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="small">
            <thead><tr><th>{a.task}</th><th>{a.modelCol}</th><th>{a.calls}</th><th>{a.failed}</th><th>{a.tokensIn}</th><th>{a.tokensOut}</th><th>{a.latency}</th></tr></thead>
            <tbody>
              {usage.items.map((i) => (
                <tr key={`${i.task}-${i.model}`}>
                  <td>{i.task}</td><td className="mono">{i.model}</td><td>{formatNumber(i.calls)}</td><td>{formatNumber(i.failed)}</td>
                  <td>{formatNumber(i.inputTokens)}</td><td>{formatNumber(i.outputTokens)}</td><td>{formatNumber(i.avgLatencyMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function Moderation() {
  const { t, fmt, formatDate } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState<'open' | 'actioned' | 'dismissed'>('open');
  const cases = useApi((s) => api.moderationCases({ status }, s), [status]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (c: ModerationCaseView, decision: ModerationDecisionRequest['decision']) => {
    setBusy(c.id);
    try {
      await api.decideCase(c.id, { decision, note: notes[c.id]?.trim() || undefined });
      cases.setData((d) => ({ items: d.items.filter((x) => x.id !== c.id) }));
      toast.show(t.admin.decided, { tone: 'success' });
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  return (
    <Section title={t.admin.moderation} id="a-mod">
      <Tabs label={t.admin.moderation} active={status} onChange={setStatus} items={[
        { id: 'open', label: t.admin.statusOpen }, { id: 'actioned', label: t.admin.statusActioned }, { id: 'dismissed', label: t.admin.statusDismissed },
      ]} />
      {cases.status === 'loading' ? <SkeletonList rows={3} label={t.common.loading} /> : null}
      {cases.status === 'error' ? <ErrorState error={cases.error} onRetry={cases.retry} /> : null}
      {cases.status === 'success' && !cases.data.items.length ? <EmptyState icon="shield" title={t.admin.casesEmpty} /> : null}
      {cases.status === 'success' && cases.data.items.length ? (
        <ul className="grid-players">
          {cases.data.items.map((c) => (
            <li key={c.id} className="card card--outline">
              <div className="row">
                <span className="badge badge--outline">{c.targetKind}</span>
                <span className="badge badge--neutral">{fmt(t.admin.source, { source: c.source })}</span>
                <span className="badge badge--warn">{fmt(t.admin.priority, { n: c.priority })}</span>
                <span className="muted small">{fmt(t.admin.reports, { n: c.reportCount })}</span>
                {c.aiModel ? <span className="badge badge--outline mono" data-testid="ai-model">{fmt(t.aiAdmin.model, { model: c.aiModel })}</span> : null}
              </div>
              {c.categories.length ? <p className="small">{c.categories.join(', ')}</p> : null}
              {c.video ? (
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  {c.video.thumbnailUrl ? <img src={c.video.thumbnailUrl} alt="" width={72} style={{ aspectRatio: '9 / 16', objectFit: 'cover', borderRadius: 8 }} /> : null}
                  <div className="stack stack--tight">
                    <Link className="link" href={`/v/${c.video.id}`} dir="auto">{c.video.title}</Link>
                    <span className="muted small">@{c.video.owner.handle} · {t.videoStatus[c.video.status]}</span>
                  </div>
                </div>
              ) : null}
              {c.organization ? (
                <p className="small"><Link className="link" href={`/org/${c.organization.id}`} dir="auto">{c.organization.name}</Link>{' '}
                  <span className="muted">· {c.organization.type} · {c.organization.status}{c.organization.verified ? ` · ${t.org.verificationApproved}` : ''}</span></p>
              ) : null}
              {c.comment ? <blockquote className="muted" dir="auto" style={{ margin: 0 }}>“{c.comment.body}” <span className="small">@{c.comment.authorHandle}</span></blockquote> : null}
              {!c.video && !c.comment ? <p className="mono muted">{c.targetId}</p> : null}
              {c.ownerCopyrightStrikes ? (
                <p className="row small" data-testid="copyright-strikes">
                  {fmt(t.admin.strikes, { n: c.ownerCopyrightStrikes })}
                  {c.ownerCopyrightStrikes >= REPEAT_INFRINGER_STRIKES ? <span className="badge badge--warn">{t.admin.repeatInfringer}</span> : null}
                </p>
              ) : null}
              {c.copyrightClaims.length ? (
                <details className="small">
                  <summary>{t.admin.copyrightClaims} ({c.copyrightClaims.length})</summary>
                  <ul className="list">
                    {c.copyrightClaims.map((x) => (
                      <li key={x.id}>
                        <span dir="auto">{fmt(t.admin.claimBy, { name: x.claimantName, email: x.claimantEmail })}</span>{' '}
                        <span className="badge badge--outline">{x.status}</span>
                        <p className="muted" dir="auto" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{x.description}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {c.counterNotice ? (
                <details className="small" open={c.counterNotice.status === 'pending'}>
                  <summary>{t.admin.counterNotice} · {c.counterNotice.status}</summary>
                  <p dir="auto" style={{ margin: 0 }}><strong>{c.counterNotice.fullName}</strong></p>
                  <p className="muted" dir="auto" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{c.counterNotice.explanation}</p>
                </details>
              ) : null}
              <time className="muted small" dateTime={c.createdAt}>{formatDate(c.createdAt)}</time>
              {c.status === 'open' ? (
                <>
                  <label className="field"><span className="field__label">{t.admin.decisionNote}</span>
                    <input className="input" maxLength={1000} value={notes[c.id] ?? ''} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} /></label>
                  <div className="row">
                    <Button size="sm" variant="primary" disabled={busy === c.id} onClick={() => decide(c, 'approve')}>{t.admin.approve}</Button>
                    <Button size="sm" variant="danger" disabled={busy === c.id} onClick={() => decide(c, 'reject')}>{t.admin.reject}</Button>
                    <Button size="sm" variant="danger" disabled={busy === c.id} onClick={() => decide(c, 'remove')}>{t.admin.remove}</Button>
                    <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => decide(c, 'dismiss')}>{t.admin.dismiss}</Button>
                  </div>
                </>
              ) : <p className="small">{c.decision}</p>}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function Verifications() {
  const { t, formatDate } = useI18n();
  const toast = useToast();
  const v = useApi((s) => api.verificationRequests(s), []);
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    try { await api.decideVerification(id, { approve }); v.setData((d) => ({ items: d.items.filter((x) => x.id !== id) })); toast.show(t.admin.decided, { tone: 'success' }); }
    catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  return (
    <Section title={t.admin.verification} id="a-ver">
      {v.status === 'loading' ? <SkeletonList rows={2} label={t.common.loading} /> : null}
      {v.status === 'error' ? <ErrorState error={v.error} onRetry={v.retry} /> : null}
      {v.status === 'success' && !v.data.items.length ? <p className="muted">{t.admin.verificationEmpty}</p> : null}
      {v.status === 'success' && v.data.items.length ? (
        <ul className="list">
          {v.data.items.map((r) => (
            <li key={r.id}>
              <div className="list__row">
                <span><Link className="link" href={`/u/${r.user.handle}`}>@{r.user.handle}</Link> <span className="muted small">{r.user.displayName}</span></span>
                <span className="row"><span className="badge badge--outline">{t.verificationKinds[r.kind]}</span><span className="muted small">{formatDate(r.createdAt)}</span></span>
              </div>
              {r.targetOrganization ? (
                <p className="small"><Link className="link" href={`/org/${r.targetOrganization.id}`} dir="auto">{r.targetOrganization.name}</Link>{' '}
                  <span className="muted">· {r.targetOrganization.type}{r.targetOrganization.country ? ` · ${r.targetOrganization.country}` : ''}</span></p>
              ) : null}
              {r.organization ? <p className="small"><strong>{t.settings.organization}:</strong> <span dir="auto">{r.organization}</span></p> : null}
              {r.evidence ? <p className="small muted" dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{r.evidence}</p> : null}
              {r.status === 'pending' ? (
                <div className="row">
                  <Button size="sm" variant="primary" loading={busy === r.id} onClick={() => decide(r.id, true)}>{t.admin.approve}</Button>
                  <Button size="sm" variant="danger" disabled={busy === r.id} onClick={() => decide(r.id, false)}>{t.admin.reject}</Button>
                </div>
              ) : <span className="badge badge--neutral">{r.status}</span>}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function CreateChallenge() {
  const { t } = useI18n();
  const toast = useToast();
  const empty = { slug: '', titleEn: '', titleAr: '', descEn: '', descAr: '', skill: '' as SkillKey | '', hashtag: '', startsAt: '', endsAt: '' };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const tag = f.hashtag.trim() ? normalizeHashtag(f.hashtag) : null;
      await api.createChallenge({
        slug: f.slug.trim(),
        title: { en: f.titleEn.trim(), ar: f.titleAr.trim() },
        description: { en: f.descEn.trim(), ar: f.descAr.trim() },
        skillKey: f.skill || undefined,
        hashtag: tag ?? undefined,
        startsAt: new Date(f.startsAt).toISOString(),
        endsAt: new Date(f.endsAt).toISOString(),
      });
      setF(empty);
      toast.show(t.admin.challengeCreated, { tone: 'success' });
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <Section title={t.admin.createChallenge} id="a-ch">
      <form className="card" onSubmit={submit}>
        <div className="form-grid">
          <label className="field"><span className="field__label">{t.admin.slug}</span><input className="input" required pattern="[a-z0-9-]{3,60}" value={f.slug} onChange={set('slug')} /></label>
          <label className="field"><span className="field__label">{t.admin.titleEn}</span><input className="input" required lang="en" dir="ltr" value={f.titleEn} onChange={set('titleEn')} /></label>
          <label className="field"><span className="field__label">{t.admin.titleAr}</span><input className="input" required lang="ar" dir="rtl" value={f.titleAr} onChange={set('titleAr')} /></label>
          <label className="field"><span className="field__label">{t.search.skill}</span>
            <select className="input" value={f.skill} onChange={set('skill')}><option value="">{t.upload.none}</option>{SKILL_KEYS.map((s) => <option key={s} value={s}>{t.skills[s]}</option>)}</select></label>
          <label className="field"><span className="field__label">{t.challenges.hashtag}</span><input className="input" value={f.hashtag} onChange={set('hashtag')} dir="auto" /></label>
          <label className="field"><span className="field__label">{t.admin.startsAt}</span><input className="input" type="datetime-local" required value={f.startsAt} onChange={set('startsAt')} /></label>
          <label className="field"><span className="field__label">{t.admin.endsAt}</span><input className="input" type="datetime-local" required value={f.endsAt} onChange={set('endsAt')} /></label>
        </div>
        <label className="field"><span className="field__label">{t.admin.descEn}</span><textarea className="input" rows={2} required lang="en" dir="ltr" value={f.descEn} onChange={set('descEn')} /></label>
        <label className="field"><span className="field__label">{t.admin.descAr}</span><textarea className="input" rows={2} required lang="ar" dir="rtl" value={f.descAr} onChange={set('descAr')} /></label>
        <div><Button type="submit" variant="primary" loading={busy}>{t.admin.createChallenge}</Button></div>
      </form>
    </Section>
  );
}

function Audit() {
  const { t, formatDate } = useI18n();
  const a = useApi((s) => api.auditLogs(s), []);
  return (
    <Section title={t.admin.audit} id="a-audit">
      {a.status === 'loading' ? <SkeletonList rows={4} label={t.common.loading} /> : null}
      {a.status === 'error' ? <ErrorState error={a.error} onRetry={a.retry} /> : null}
      {a.status === 'success' && !a.data.items.length ? <p className="muted">{t.admin.auditEmpty}</p> : null}
      {a.status === 'success' && a.data.items.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t.admin.colTime}</th><th>{t.admin.colAction}</th><th>{t.admin.colActor}</th><th>{t.admin.colTarget}</th></tr></thead>
            <tbody>
              {a.data.items.map((x) => (
                <tr key={x.id}>
                  <td><time dateTime={x.createdAt}>{formatDate(x.createdAt)}</time></td>
                  <td className="mono">{x.action}</td>
                  <td className="mono">{x.actorId?.slice(0, 8) ?? '—'}</td>
                  <td className="mono">{x.targetKind ?? ''} {x.targetId?.slice(0, 8) ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Section>
  );
}
