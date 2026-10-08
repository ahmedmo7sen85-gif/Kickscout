'use client';

import { useState, type FormEvent } from 'react';
import { INVITABLE_ORG_ROLES, canManageMember } from '@fp/domain';
import { Section } from '@/components/PageHead';
import { OrgHeader } from '@/components/org/OrgHeader';
import { OrgMembers } from '@/components/org/OrgMembers';
import { Button, ButtonLink } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { ReportSheet } from '@/components/video/ReportSheet';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { InvitableOrgRole, OrganizationDashboard } from '@/lib/types';

export function OrgView({ id }: { id: string }) {
  const { t } = useI18n();
  const { status } = useAuth();
  const org = useApi((s) => api.org(id, s), [id, status], { enabled: status !== 'loading' });
  const [reporting, setReporting] = useState(false);
  if (org.status === 'loading') return <div className="wrap page"><SkeletonList rows={4} label={t.common.loading} /></div>;
  if (org.status === 'error') {
    return <div className="wrap page">{org.error.status === 404 ? <EmptyState icon="search" title={t.org.notFound} /> : <ErrorState error={org.error} onRetry={org.retry} />}</div>;
  }
  return (
    <div className="wrap page stack stack--loose" style={{ maxInlineSize: '64rem' }}>
      <OrgHeader org={org.data} />
      {org.data.myRole ? <Dashboard id={id} /> : (
        status === 'signed_in' ? <div><Button variant="ghost" onClick={() => setReporting(true)}>{t.org.report}</Button></div> : null
      )}
      <ReportSheet targetKind="organization" targetId={id} open={reporting} onClose={() => setReporting(false)} />
    </div>
  );
}

function Dashboard({ id }: { id: string }) {
  const { t, fmt } = useI18n();
  const d = useApi((s) => api.orgDashboard(id, s), [id]);
  if (d.status === 'loading') return <SkeletonList rows={4} label={t.common.loading} />;
  if (d.status === 'error') return <ErrorState error={d.error} onRetry={d.retry} />;
  const manage = d.data.myRole === 'owner' || d.data.myRole === 'admin';
  return (
    <div className="stack stack--loose" data-testid="org-dashboard">
      {d.data.status === 'suspended' ? <p className="notice notice--warn" role="status">{t.org.suspended}</p> : null}
      <div className="row">
        <span className="muted">{fmt(t.org.yourRole, { role: t.orgRoles[d.data.myRole] })}</span>
        <ButtonLink href={`/scout/pipeline?org=${encodeURIComponent(id)}`} variant="primary">{t.org.pipeline}</ButtonLink>
      </div>
      <Members data={d.data} reload={d.retry} />
      {manage ? <Invitations data={d.data} reload={d.retry} /> : null}
      <Verification data={d.data} reload={d.retry} manage={manage} />
      {d.data.myRole !== 'owner' ? <Leave id={id} /> : null}
    </div>
  );
}

function Members({ data, reload }: { data: OrganizationDashboard; reload: () => void }) {
  const { t } = useI18n();
  const { me } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast.show(ok, { tone: 'success' }); reload(); } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  return (
    <Section title={t.org.members} id="org-members">
      <OrgMembers members={data.members} myRole={data.myRole} myUserId={me?.userId ?? null} busyId={busy}
        onRoleChange={(m, role) => run(m.userId, () => api.setOrgMemberRole(data.id, m.userId, { role }), t.org.roleChanged)}
        onRemove={(m) => run(m.userId, () => api.removeOrgMember(data.id, m.userId), t.org.removed)} />
    </Section>
  );
}

function Invitations({ data, reload }: { data: OrganizationDashboard; reload: () => void }) {
  const { t, fmt, formatDate } = useI18n();
  const toast = useToast();
  const roles = INVITABLE_ORG_ROLES.filter((r) => canManageMember(data.myRole, null, r));
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableOrgRole>(roles.includes('scout') ? 'scout' : roles[0] ?? 'viewer');
  const [busy, setBusy] = useState<string | null>(null);
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('new');
    try { await api.inviteToOrg(data.id, { email: email.trim(), role }); setEmail(''); toast.show(t.org.invited, { tone: 'success' }); reload(); }
    catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  const revoke = async (invId: string) => {
    setBusy(invId);
    try { await api.revokeOrgInvitation(data.id, invId); reload(); } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  return (
    <Section title={t.org.invites} id="org-invites">
      <form className="row" onSubmit={invite}>
        <label className="sr-only" htmlFor="inv-email">{t.org.inviteEmail}</label>
        <input id="inv-email" className="input" style={{ flex: 1, minInlineSize: '14rem' }} type="email" required placeholder={t.org.inviteEmail} value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="sr-only" htmlFor="inv-role">{t.org.inviteRole}</label>
        <select id="inv-role" className="input input--sm" value={role} onChange={(e) => setRole(e.target.value as InvitableOrgRole)}>
          {roles.map((r) => <option key={r} value={r}>{t.orgRoles[r]}</option>)}
        </select>
        <Button type="submit" variant="primary" loading={busy === 'new'} disabled={!email.trim()}>{t.org.invite}</Button>
      </form>
      {data.invitations.length ? (
        <ul className="list">
          {data.invitations.map((i) => (
            <li key={i.id} className="list__row">
              <span>{i.email} <span className="badge badge--outline">{t.orgRoles[i.role]}</span></span>
              <span className="row">
                <span className="muted small">{i.status === 'expired' ? t.org.expired : fmt(t.org.expires, { date: formatDate(i.expiresAt) })}</span>
                <Button size="sm" variant="ghost" disabled={busy === i.id} onClick={() => revoke(i.id)}>{t.org.revoke}</Button>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">{t.org.invitesEmpty}</p>}
    </Section>
  );
}

function Verification({ data, reload, manage }: { data: OrganizationDashboard; reload: () => void; manage: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const status = data.verification.status;
  const text = { none: t.org.verificationNone, pending: t.org.verificationPending, approved: t.org.verificationApproved, rejected: t.org.verificationRejected }[status];
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await api.requestVerification({ kind: 'organization', organizationId: data.id, evidence: evidence.trim() }); toast.show(t.settings.verificationSent, { tone: 'success' }); reload(); }
    catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <Section title={t.org.verification} id="org-verification">
      <p className="muted small">{t.org.verificationText}</p>
      <p data-testid="org-verification-status">{text}</p>
      {manage && (status === 'none' || status === 'rejected') && !data.verified ? (
        <form className="stack" onSubmit={send}>
          <label className="field"><span className="field__label">{t.org.evidence}</span>
            <textarea className="input" required minLength={10} maxLength={1000} rows={3} value={evidence} onChange={(e) => setEvidence(e.target.value)} dir="auto" /></label>
          <div><Button type="submit" variant="primary" loading={busy} disabled={evidence.trim().length < 10}>{t.org.requestVerification}</Button></div>
        </form>
      ) : null}
    </Section>
  );
}

function Leave({ id }: { id: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const leave = async () => {
    setBusy(true);
    try { await api.leaveOrg(id); toast.show(t.org.left, { tone: 'success' }); window.location.assign('/org/new'); }
    catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return <div><Button variant="danger" loading={busy} onClick={leave}>{t.org.leave}</Button></div>;
}
