'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { BillingSummary } from '@/components/billing/BillingSummary';
import { LocaleSwitch } from '@/components/nav/LocaleSwitch';
import { PageHead } from '@/components/PageHead';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api, isApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { CONSENT_PURPOSES, FEET, NOTIFICATION_PREFERENCE_KEYS, POSITIONS, PRIVACY_TOGGLES, PROFILE_VISIBILITIES } from '@/lib/constants';
import { publicEnv } from '@/lib/env';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type {
  ConsentPurpose, ConsentState, Foot, MeView, NotificationPreferenceKey, Position, PrivacySettingsView, UpdatePrivacyRequest,
} from '@/lib/types';

export function SettingsView() {
  const { t } = useI18n();
  return (
    <div className="wrap wrap--mid page">
      <PageHead title={t.settings.title} />
      <AuthGate><Sections /></AuthGate>
    </div>
  );
}

function Sections() {
  const { t, fmt } = useI18n();
  const { me, meError, refreshMe, signOut } = useAuth();
  if (!me) return meError ? <ErrorState error={meError} onRetry={() => void refreshMe()} /> : null;
  const minor = me.ageGroup !== 'adult';
  return (
    <div className="stack stack--loose">
      <ProfileForm me={me} onSaved={refreshMe} />
      <Visibility me={me} minor={minor} />
      <Consents me={me} minor={minor} />
      {minor || me.guardianRequired ? <GuardianInvite /> : null}
      <Verification me={me} onSent={refreshMe} />
      <ContactRequests />
      <NotificationPrefs />
      <Billing roles={me.roles} />
      <section className="card" aria-labelledby="s-lang">
        <h2 className="section-title" id="s-lang">{t.settings.languageSection}</h2>
        <div><LocaleSwitch /></div>
      </section>
      <section className="card" aria-labelledby="s-acc">
        <h2 className="section-title" id="s-acc">{t.settings.accountSection}</h2>
        <p className="muted">{fmt(t.settings.signedInAs, { handle: me.profile.handle })}</p>
        <div><Button onClick={() => void signOut()}>{t.common.logOut}</Button></div>
      </section>
      <YourData />
      <DeleteAccount minor={minor} onDeleted={signOut} />
    </div>
  );
}

function ProfileForm({ me, onSaved }: { me: MeView; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const toast = useToast();
  const p = me.profile;
  const [displayName, setDisplayName] = useState(p.displayName);
  const [bio, setBio] = useState(p.bio ?? '');
  const [regionCode, setRegionCode] = useState('');
  const [primary, setPrimary] = useState<Position | ''>(p.player?.primaryPosition ?? '');
  const [secondary, setSecondary] = useState<Position[]>(p.player?.secondaryPositions ?? []);
  const [foot, setFoot] = useState<Foot | ''>(p.player?.preferredFoot ?? '');
  const [saving, setSaving] = useState(false);
  const isPlayer = me.roles.includes('player');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.updateProfile(me.userId, {
        displayName: displayName.trim(),
        bio: bio.trim() || null,
        ...(regionCode.trim() ? { regionCode: regionCode.trim() } : {}),
        ...(isPlayer ? { player: { primaryPosition: primary || null, secondaryPositions: secondary, preferredFoot: foot || null } } : {}),
      });
      toast.show(t.settings.profileSaved, { tone: 'success' });
      await onSaved();
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setSaving(false); }
  };

  return (
    <form className="card" onSubmit={save} aria-labelledby="s-prof" id="profile">
      <h2 className="section-title" id="s-prof">{t.settings.profileSection}</h2>
      <label className="field"><span className="field__label">{t.settings.displayName}</span>
        <input className="input" required maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} dir="auto" /></label>
      <label className="field"><span className="field__label">{t.settings.bio}</span>
        <textarea className="input" rows={3} maxLength={300} value={bio} onChange={(e) => setBio(e.target.value)} dir="auto" /></label>
      <label className="field"><span className="field__label">{t.settings.regionCode}</span>
        <input className="input" maxLength={40} value={regionCode} onChange={(e) => setRegionCode(e.target.value)} />
        <span className="field__hint">{t.settings.regionHint}</span></label>
      {isPlayer ? (
        <>
          <label className="field"><span className="field__label">{t.settings.primaryPosition}</span>
            <select className="input" value={primary} onChange={(e) => setPrimary(e.target.value as Position | '')}>
              <option value="">{t.upload.none}</option>{POSITIONS.map((x) => <option key={x} value={x}>{t.positions[x]}</option>)}</select></label>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field__label">{t.settings.secondaryPositions}</legend>
            <div className="chips">
              {POSITIONS.filter((x) => x !== primary).map((x) => (
                <label key={x} className={`chip chip--sm${secondary.includes(x) ? ' is-active' : ''}`}>
                  <input type="checkbox" className="sr-only" checked={secondary.includes(x)}
                    onChange={(e) => setSecondary(e.target.checked ? [...secondary, x] : secondary.filter((y) => y !== x))} />
                  {t.positions[x]}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field"><span className="field__label">{t.settings.preferredFoot}</span>
            <select className="input" value={foot} onChange={(e) => setFoot(e.target.value as Foot | '')}>
              <option value="">{t.upload.none}</option>{FEET.map((x) => <option key={x} value={x}>{t.feet[x]}</option>)}</select></label>
        </>
      ) : null}
      <div><Button type="submit" variant="primary" loading={saving}>{t.settings.saveProfile}</Button></div>
    </form>
  );
}

function latest(state: ConsentState, purpose: ConsentPurpose): boolean {
  const rows = state.consents.filter((c) => c.purpose === purpose).sort((a, b) => b.at.localeCompare(a.at));
  return rows[0]?.granted ?? false;
}

function Consents({ me, minor }: { me: MeView; minor: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const c = useApi((s) => api.consents(me.userId, s), [me.userId]);
  const [busy, setBusy] = useState<ConsentPurpose | null>(null);
  const toggle = async (purpose: ConsentPurpose, granted: boolean) => {
    setBusy(purpose);
    try {
      await api.setConsent({ subjectId: me.userId, purpose, granted, policyVersion: publicEnv.policyVersion });
      c.setData((d) => ({ ...d, consents: [...d.consents, { purpose, granted, policyVersion: publicEnv.policyVersion, at: new Date().toISOString() }] }));
      toast.show(t.settings.consentSaved, { tone: 'success' });
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  return (
    <section className="card" aria-labelledby="s-priv" id="privacy">
      <h2 className="section-title" id="s-priv">{t.settings.privacySection}</h2>
      <p className="muted small">{t.settings.privacyIntro}</p>
      {minor ? <p className="notice notice--warn small">{t.settings.minorConsentNote}</p> : null}
      {c.status === 'loading' ? <SkeletonList rows={3} label={t.common.loading} /> : null}
      {c.status === 'error' ? <ErrorState error={c.error} onRetry={c.retry} /> : null}
      {c.status === 'success' ? (
        <ul className="list">
          {CONSENT_PURPOSES.map((purpose) => {
            const on = latest(c.data, purpose);
            return (
              <li key={purpose} className="list__row">
                <span>
                  <strong id={`cp-${purpose}`}>{t.settings[`purpose_${purpose}`]}</strong><br />
                  <span className="muted small">{t.settings[`purpose_${purpose}Text`]}</span>
                </span>
                <button type="button" role="switch" className="toggle" aria-checked={on} aria-labelledby={`cp-${purpose}`}
                  disabled={busy === purpose || purpose === 'account'} onClick={() => toggle(purpose, !on)}>
                  <span className="sr-only">{on ? t.settings.granted : t.settings.notGranted}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function GuardianInvite() {
  const { t, fmt, formatDate } = useI18n();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { const r = await api.inviteGuardian({ guardianEmail: email.trim() }); setSent(r.expiresAt); setEmail(''); } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <form className="card" onSubmit={send} aria-labelledby="s-guard" id="guardian">
      <h2 className="section-title" id="s-guard">{t.settings.guardianSection}</h2>
      <p className="muted small">{t.settings.guardianText}</p>
      <label className="field"><span className="field__label">{t.settings.guardianEmail}</span>
        <input className="input" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      {sent ? <p className="notice notice--accent small" role="status">{fmt(t.settings.inviteSent, { date: formatDate(sent) })}</p> : null}
      <div><Button type="submit" variant="primary" loading={busy}>{t.settings.sendInvite}</Button></div>
    </form>
  );
}

function Verification({ me, onSent }: { me: MeView; onSent: () => Promise<void> }) {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const [kind, setKind] = useState<'scout' | 'player' | 'identity'>(me.roles.includes('player') ? 'player' : 'scout');
  const [organization, setOrganization] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => { if (typeof window !== 'undefined' && window.location.hash === '#verification') setKind('scout'); }, []);
  const statusText = { none: t.settings.statusNone, pending: t.settings.statusPending, approved: t.settings.statusApproved, rejected: t.settings.statusRejected }[me.scoutApplication];
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.requestVerification({ kind, organization: organization.trim() || undefined, evidence: evidence.trim() });
      setDone(true);
      toast.show(t.settings.verificationSent, { tone: 'success' });
      await onSent();
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <form className="card" onSubmit={send} aria-labelledby="s-ver" id="verification">
      <h2 className="section-title" id="s-ver">{t.settings.verificationSection}</h2>
      <p className="muted small">{t.settings.verificationText}</p>
      <p className="small">{fmt(t.settings.scoutStatus, { status: statusText })}</p>
      <fieldset className="radio-list">
        <legend className="field__label">{t.settings.verificationKind}</legend>
        {(['scout', 'player', 'identity'] as const).map((k) => (
          <label key={k} className={`radio-row${kind === k ? ' is-checked' : ''}`}>
            <input type="radio" name="vkind" checked={kind === k} onChange={() => setKind(k)} />
            {k === 'scout' ? t.settings.kindScout : k === 'player' ? t.settings.kindPlayer : t.settings.kindIdentity}
          </label>
        ))}
      </fieldset>
      <label className="field"><span className="field__label">{t.settings.organization}{kind !== 'scout' ? ` · ${t.common.optional}` : ''}</span>
        <input className="input" required={kind === 'scout'} minLength={2} maxLength={120} value={organization} onChange={(e) => setOrganization(e.target.value)} dir="auto" /></label>
      <label className="field"><span className="field__label">{t.settings.evidence}</span>
        <textarea className="input" required minLength={10} maxLength={1000} rows={4} value={evidence} onChange={(e) => setEvidence(e.target.value)} dir="auto" />
        <span className="field__hint">{t.settings.evidenceHint}</span></label>
      {done ? <p className="notice notice--accent small" role="status">{t.settings.verificationSent}</p> : null}
      <div><Button type="submit" variant="primary" loading={busy} disabled={done}>{t.settings.applyVerification}</Button></div>
    </form>
  );
}

function ContactRequests() {
  const { t, formatDate } = useI18n();
  const toast = useToast();
  const r = useApi((s) => api.contactRequests('incoming', s), []);
  const [busy, setBusy] = useState<string | null>(null);
  const respond = async (id: string, accept: boolean) => {
    setBusy(id);
    try {
      const updated = await api.respondContact(id, { accept });
      r.setData((d) => ({ items: d.items.map((x) => (x.id === id ? updated : x)) }));
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  return (
    <section className="card" aria-labelledby="s-contact" id="contact">
      <h2 className="section-title" id="s-contact">{t.settings.contactSection}</h2>
      <p className="muted small">{t.settings.contactIntro}</p>
      {r.status === 'loading' ? <SkeletonList rows={2} label={t.common.loading} /> : null}
      {r.status === 'error' ? <ErrorState error={r.error} onRetry={r.retry} /> : null}
      {r.status === 'success' && !r.data.items.length ? <p className="muted small">{t.settings.contactEmpty}</p> : null}
      {r.status === 'success' && r.data.items.length ? (
        <ul className="list">
          {r.data.items.map((x) => (
            <li key={x.id}>
              <div className="list__row">
                <span><strong dir="auto">{x.scout.displayName}</strong> <span className="muted small">@{x.scout.handle}{x.scout.organization ? ` · ${x.scout.organization}` : ''}</span></span>
                <span className="row">
                  {x.viaGuardian ? <span className="badge badge--outline">{t.contact.viaGuardian}</span> : null}
                  <span className={`badge ${x.status === 'accepted' ? 'badge--green' : 'badge--outline'}`}>{t.contact[x.status]}</span>
                  <time className="muted small" dateTime={x.createdAt}>{formatDate(x.createdAt)}</time>
                </span>
              </div>
              <p className="muted" dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{x.message}</p>
              {x.status === 'pending' ? (
                <div className="row">
                  <Button size="sm" variant="primary" loading={busy === x.id} onClick={() => respond(x.id, true)}>{t.settings.accept}</Button>
                  <Button size="sm" variant="ghost" disabled={busy === x.id} onClick={() => respond(x.id, false)}>{t.settings.decline}</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Visibility({ me, minor }: { me: MeView; minor: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const p = useApi((s) => api.privacy(me.userId, s), [me.userId]);
  const [busy, setBusy] = useState(false);
  // The server decides what a minor may change; a refused change leaves the settings as they were.
  const save = async (patch: UpdatePrivacyRequest) => {
    setBusy(true);
    try {
      const next = await api.updatePrivacy(me.userId, patch);
      p.setData(() => next);
      toast.show(t.settings.privacySaved, { tone: 'success' });
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <section className="card" aria-labelledby="s-vis" id="visibility">
      <h2 className="section-title" id="s-vis">{t.settings.visibilitySection}</h2>
      <p className="muted small">{t.settings.visibilityIntro}</p>
      {minor ? <p className="notice notice--warn small">{t.settings.minorPrivacyNote}</p> : null}
      {p.status === 'loading' ? <SkeletonList rows={3} label={t.common.loading} /> : null}
      {p.status === 'error' ? <ErrorState error={p.error} onRetry={p.retry} /> : null}
      {p.status === 'success' ? <VisibilityForm data={p.data} busy={busy} onChange={save} /> : null}
    </section>
  );
}

function VisibilityForm({ data, busy, onChange }: { data: PrivacySettingsView; busy: boolean; onChange: (patch: UpdatePrivacyRequest) => void }) {
  const { t } = useI18n();
  return (
    <>
      <fieldset className="radio-list" data-testid="visibility">
        <legend className="sr-only">{t.settings.visibilitySection}</legend>
        {PROFILE_VISIBILITIES.map((v) => (
          <label key={v} className={`radio-row${data.profileVisibility === v ? ' is-checked' : ''}`}>
            <input type="radio" name="visibility" checked={data.profileVisibility === v} disabled={busy}
              onChange={() => onChange({ profileVisibility: v })} />
            <span><strong>{t.settings[`vis_${v}`]}</strong><br /><span className="muted small">{t.settings[`vis_${v}Text`]}</span></span>
          </label>
        ))}
      </fieldset>
      <ul className="list">
        {PRIVACY_TOGGLES.map((key) => (
          <li key={key} className="list__row">
            <span>
              <strong id={`pt-${key}`}>{t.settings[`toggle_${key}`]}</strong><br />
              <span className="muted small">{t.settings[`toggle_${key}Text`]}</span>
            </span>
            <button type="button" role="switch" className="toggle" aria-checked={data[key]} aria-labelledby={`pt-${key}`}
              disabled={busy} onClick={() => onChange({ [key]: !data[key] })}>
              <span className="sr-only">{data[key] ? t.settings.granted : t.settings.notGranted}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function NotificationPrefs() {
  const { t } = useI18n();
  const toast = useToast();
  const n = useApi((s) => api.notificationPreferences(s), []);
  const [busy, setBusy] = useState<NotificationPreferenceKey | null>(null);
  const toggle = async (key: NotificationPreferenceKey, on: boolean) => {
    setBusy(key);
    try {
      const next = await api.updateNotificationPreferences({ [key]: on });
      n.setData(() => next);
      toast.show(t.settings.notificationsSaved, { tone: 'success' });
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  return (
    <section className="card" aria-labelledby="s-notif" id="notifications">
      <h2 className="section-title" id="s-notif">{t.settings.notificationsSection}</h2>
      <p className="muted small">{t.settings.notificationsIntro}</p>
      {n.status === 'loading' ? <SkeletonList rows={3} label={t.common.loading} /> : null}
      {n.status === 'error' ? <ErrorState error={n.error} onRetry={n.retry} /> : null}
      {n.status === 'success' ? (
        <ul className="list">
          {NOTIFICATION_PREFERENCE_KEYS.map((key) => (
            <li key={key} className="list__row">
              <strong id={`np-${key}`}>{t.settings[`notif_${key}`]}</strong>
              <button type="button" role="switch" className="toggle" aria-checked={n.data[key]} aria-labelledby={`np-${key}`}
                disabled={busy === key} onClick={() => toggle(key, !n.data[key])}>
                <span className="sr-only">{n.data[key] ? t.settings.granted : t.settings.notGranted}</span>
              </button>
            </li>
          ))}
          <li className="list__row">
            <span>
              <strong id="np-security">{t.settings.notif_security}</strong><br />
              <span className="muted small">{t.settings.notif_securityText}</span>
            </span>
            <button type="button" role="switch" className="toggle" aria-checked aria-labelledby="np-security" disabled>
              <span className="sr-only">{t.settings.granted}</span>
            </button>
          </li>
        </ul>
      ) : null}
    </section>
  );
}

function Billing({ roles }: { roles: readonly string[] }) {
  const { t } = useI18n();
  const toast = useToast();
  const e = useApi((s) => api.entitlements(s), []);
  const [busy, setBusy] = useState(false);
  const [off, setOff] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('checkout') === 'success') setConfirming(true);
  }, []);
  const manage = async () => {
    setBusy(true);
    try {
      const r = await api.billingPortal();
      window.location.assign(r.url);
    } catch (err) {
      if (isApiError(err) && err.isBillingOff) setOff(true);
      else toast.show(errorMessage(err, t), { tone: 'error' });
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="s-billing" id="billing">
      <h2 className="section-title" id="s-billing">{t.billing.sectionTitle}</h2>
      {e.status === 'loading' ? <SkeletonList rows={2} label={t.common.loading} /> : null}
      {e.status === 'error' ? <ErrorState error={e.error} onRetry={e.retry} /> : null}
      {e.status === 'success' ? (
        <BillingSummary data={e.data} roles={roles} paymentsOff={off} busy={busy} confirming={confirming} onManage={manage} onRefresh={e.retry} />
      ) : null}
    </section>
  );
}

function YourData() {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const data = await api.exportMyData();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `kickscout-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.show(t.settings.dataReady, { tone: 'success' });
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <section className="card" aria-labelledby="s-data" id="data">
      <h2 className="section-title" id="s-data">{t.settings.dataSection}</h2>
      <p className="muted small">{t.settings.dataText}</p>
      <div><Button onClick={download} loading={busy} data-testid="export-data">{t.settings.dataDownload}</Button></div>
    </section>
  );
}

function DeleteAccount({ minor, onDeleted }: { minor: boolean; onDeleted: () => Promise<void> }) {
  const { t } = useI18n();
  const toast = useToast();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (confirm !== 'DELETE') return;
    setBusy(true);
    try {
      const r = await api.deleteMyAccount({ confirm: 'DELETE' });
      if (r.status === 'pending_guardian') { setPending(true); return; }
      toast.show(t.settings.deleteDone, { tone: 'success' });
      await onDeleted();
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <form className="card" onSubmit={submit} aria-labelledby="s-del" id="delete">
      <h2 className="section-title" id="s-del">{t.settings.deleteSection}</h2>
      <p className="small">{t.settings.deleteIntro}</p>
      <ul className="small">
        <li>{t.settings.deleteConsequence1}</li>
        <li>{t.settings.deleteConsequence2}</li>
        <li>{t.settings.deleteConsequence3}</li>
        <li>{t.settings.deleteConsequence4}</li>
      </ul>
      {minor ? <p className="notice notice--warn small">{t.settings.deleteMinorNote}</p> : null}
      {pending ? <p className="notice notice--accent small" role="status">{t.settings.deletePending}</p> : (
        <>
          <label className="field"><span className="field__label">{t.settings.deleteConfirmLabel}</span>
            <input className="input" autoComplete="off" spellCheck={false} value={confirm} onChange={(e) => setConfirm(e.target.value)}
              data-testid="delete-confirm" /></label>
          <div><Button type="submit" variant="danger" loading={busy} disabled={confirm !== 'DELETE'}>{t.settings.deleteCta}</Button></div>
        </>
      )}
    </form>
  );
}
