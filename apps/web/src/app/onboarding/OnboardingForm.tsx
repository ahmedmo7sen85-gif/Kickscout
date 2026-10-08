'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { PageHead } from '@/components/PageHead';
import { Button, ButtonLink } from '@/components/ui/Button';
import { api, isApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { HANDLE_RE } from '@/lib/constants';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import type { RegisterResponse } from '@/lib/types';

/** Whole years between a YYYY-MM-DD date and today, or null. Only a hint: the API applies the age rules. */
export function ageFrom(dob: string, now = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d)) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

export function OnboardingForm() {
  const { t } = useI18n();
  return (
    <div className="wrap wrap--narrow page">
      <PageHead title={t.onboarding.title} intro={t.onboarding.intro} />
      <AuthGate requireProfile={false}><Form /></AuthGate>
    </div>
  );
}

function Form() {
  const { t, locale, fmt, formatDate } = useI18n();
  const { me, refreshMe } = useAuth();
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [dob, setDob] = useState('');
  const [country, setCountry] = useState('');
  const [roles, setRoles] = useState<('player' | 'fan')[]>(['player']);
  const [scout, setScout] = useState(false);
  const [organization, setOrganization] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RegisterResponse | null>(null);
  const [guardianEmail, setGuardianEmail] = useState('');
  const [invited, setInvited] = useState<string | null>(null);

  if (me && !result) {
    return <div className="card"><p>{t.errors.ALREADY_REGISTERED}</p><div><ButtonLink href="/home" variant="primary">{t.onboarding.continue}</ButtonLink></div></div>;
  }

  const age = ageFrom(dob);
  const minor = age !== null && age < 18;
  const tooYoung = age !== null && age < 13;
  const toggleRole = (r: 'player' | 'fan') => setRoles((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]));
  const handleOk = HANDLE_RE.test(handle);
  const countryOk = /^[A-Z]{2}$/.test(country);
  const valid = handleOk && displayName.trim() && dob && countryOk && roles.length > 0 && !tooYoung
    && (!scout || (organization.trim().length >= 2 && evidence.trim().length >= 10));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api.register({
        handle, displayName: displayName.trim(), dob, countryCode: country, roles,
        scoutApplication: scout ? { organization: organization.trim(), evidence: evidence.trim() } : undefined,
        locale,
      });
      setResult(res);
      await refreshMe();
      if (!res.guardianRequired && res.status === 'active') router.push('/home');
    } catch (err) {
      setError(errorMessage(err, t));
      if (isApiError(err) && err.code === 'ALREADY_REGISTERED') router.push('/home');
    } finally { setBusy(false); }
  };

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const r = await api.inviteGuardian({ guardianEmail: guardianEmail.trim() }); setInvited(r.expiresAt); } catch (err) { setError(errorMessage(err, t)); } finally { setBusy(false); }
  };

  if (result) {
    return (
      <div className="card stack">
        <h2 className="section-title">{result.guardianRequired ? t.onboarding.pendingTitle : t.onboarding.doneTitle}</h2>
        <p className="muted">{result.guardianRequired ? t.onboarding.pendingText : t.onboarding.doneText}</p>
        {result.guardianRequired ? (
          <form className="stack" onSubmit={invite}>
            <p className="small">{t.onboarding.guardianExplain}</p>
            <label className="field"><span className="field__label">{t.settings.guardianEmail}</span>
              <input className="input" type="email" required value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)} dir="ltr" /></label>
            {invited ? <p className="notice notice--accent small" role="status">{fmt(t.settings.inviteSent, { date: formatDate(invited) })}</p> : null}
            {error ? <p className="field__error" role="alert">{error}</p> : null}
            <div className="row">
              <Button type="submit" variant="primary" loading={busy} disabled={!!invited}>{t.onboarding.inviteGuardian}</Button>
              <ButtonLink href="/home">{t.onboarding.continue}</ButtonLink>
            </div>
          </form>
        ) : <div><ButtonLink href="/home" variant="primary">{t.onboarding.continue}</ButtonLink></div>}
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit} noValidate={false}>
      <label className="field"><span className="field__label">{t.onboarding.handle}</span>
        <input className="input" required pattern="[a-zA-Z0-9_.]{3,30}" value={handle} onChange={(e) => setHandle(e.target.value.trim())} dir="ltr" autoCapitalize="none" autoCorrect="off" />
        <span className="field__hint">{t.onboarding.handleHint}</span></label>
      <label className="field"><span className="field__label">{t.onboarding.displayName}</span>
        <input className="input" required maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} dir="auto" /></label>
      <label className="field"><span className="field__label">{t.onboarding.dob}</span>
        <input className="input" type="date" required value={dob} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDob(e.target.value)} />
        <span className="field__hint">{t.onboarding.dobHint}</span></label>
      {tooYoung ? <p className="field__error" role="alert">{t.onboarding.under13}</p> : null}
      {minor && !tooYoung ? (
        <div className="notice notice--accent" role="note">
          <strong>{t.onboarding.guardianTitle}</strong>
          <p>{t.onboarding.guardianExplain}</p>
        </div>
      ) : null}
      <label className="field"><span className="field__label">{t.onboarding.country}</span>
        <input className="input" required maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} dir="ltr" autoCapitalize="characters" />
        <span className="field__hint">{t.onboarding.countryHint}</span></label>
      <fieldset className="radio-list">
        <legend className="field__label">{t.onboarding.role}</legend>
        <label className={`radio-row${roles.includes('player') ? ' is-checked' : ''}`}><input type="checkbox" checked={roles.includes('player')} onChange={() => toggleRole('player')} />{t.onboarding.rolePlayer}</label>
        <label className={`radio-row${roles.includes('fan') ? ' is-checked' : ''}`}><input type="checkbox" checked={roles.includes('fan')} onChange={() => toggleRole('fan')} />{t.onboarding.roleFan}</label>
        <span className="field__hint">{t.onboarding.roleHint}</span>
      </fieldset>
      {!minor ? (
        <div className="stack">
          <label className="check"><input type="checkbox" checked={scout} onChange={(e) => { setScout(e.target.checked); if (e.target.checked && !roles.includes('fan')) toggleRole('fan'); }} />{t.onboarding.scoutToggle}</label>
          {scout ? (
            <>
              <p className="field__hint">{t.onboarding.scoutHint}</p>
              <label className="field"><span className="field__label">{t.onboarding.organization}</span>
                <input className="input" required minLength={2} maxLength={120} value={organization} onChange={(e) => setOrganization(e.target.value)} dir="auto" /></label>
              <label className="field"><span className="field__label">{t.onboarding.evidence}</span>
                <textarea className="input" required minLength={10} maxLength={1000} rows={3} value={evidence} onChange={(e) => setEvidence(e.target.value)} dir="auto" />
                <span className="field__hint">{t.settings.evidenceHint}</span></label>
            </>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="field__error" role="alert">{error}</p> : null}
      <div><Button type="submit" variant="primary" size="lg" loading={busy} disabled={!valid}>{t.onboarding.submit}</Button></div>
    </form>
  );
}
