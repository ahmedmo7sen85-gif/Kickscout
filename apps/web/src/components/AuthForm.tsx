'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { CapabilityBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { AuthNotConfigured } from '@/components/ui/States';
import { authConfigured } from '@/lib/env';
import { useI18n } from '@/lib/i18n/provider';
import { readNext, withNext } from '@/lib/next-path';
import { getSupabase } from '@/lib/supabase';

/** Email/password and Google via Supabase Auth. Apple is shown with its Coming Soon label. */
export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const { t } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'email' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => { setNext(readNext()); }, []);

  if (!authConfigured) {
    return (
      <div className="card auth-card stack">
        <h1 className="page-title" style={{ fontSize: '2.2rem' }}>{mode === 'login' ? t.auth.loginTitle : t.auth.signupTitle}</h1>
        <AuthNotConfigured />
      </div>
    );
  }

  const redirectTo = () => withNext(`${window.location.origin}/auth/callback`, next);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const sb = getSupabase();
    if (!sb) return;
    setBusy('email'); setError(null); setInfo(null);
    try {
      if (mode === 'login') {
        const { error: err } = await sb.auth.signInWithPassword({ email, password });
        if (err) { setError(t.auth.invalid); return; }
        router.push(next ?? '/home');
      } else {
        const { data, error: err } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo() } });
        if (err) { setError(err.message); return; }
        if (data.session) router.push(withNext('/onboarding', next)); else setInfo(t.auth.checkEmail);
      }
    } finally { setBusy(null); }
  };
  const google = async () => {
    const sb = getSupabase();
    if (!sb) return;
    setBusy('google'); setError(null);
    const { error: err } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo() } });
    if (err) { setError(err.message); setBusy(null); }
  };

  return (
    <div className="card auth-card stack">
      <div className="stack stack--tight">
        <h1 className="page-title" style={{ fontSize: '2.2rem' }}>{mode === 'login' ? t.auth.loginTitle : t.auth.signupTitle}</h1>
        {mode === 'signup' ? <p className="muted">{t.auth.signupIntro}</p> : null}
      </div>
      <div className="oauth">
        <Button block onClick={google} loading={busy === 'google'}>{t.auth.google}</Button>
        <Button block disabled aria-describedby="apple-soon">{t.auth.apple} <span id="apple-soon"><CapabilityBadge status="coming_soon" /></span></Button>
      </div>
      <div className="or">{t.common.or}</div>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span className="field__label">{t.auth.email}</span>
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" /></label>
        <label className="field"><span className="field__label">{t.auth.password}</span>
          <input className="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8}
            value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" />
          {mode === 'signup' ? <span className="field__hint">{t.auth.passwordHint}</span> : null}</label>
        {error ? <p className="field__error" role="alert">{error}</p> : null}
        {info ? <p className="notice notice--accent" role="status">{info}</p> : null}
        {mode === 'signup' ? (
          <p className="small muted" data-testid="signup-legal">
            {t.legal.signupAgree}{' '}
            <Link className="link" href="/legal/terms">{t.legal.terms}</Link>{' · '}
            <Link className="link" href="/legal/privacy">{t.legal.privacy}</Link>{' · '}
            <Link className="link" href="/legal/community-guidelines">{t.legal.community}</Link>{' · '}
            <Link className="link" href="/legal/scout-terms">{t.legal.scouts}</Link>
          </p>
        ) : null}
        <Button type="submit" variant="primary" block loading={busy === 'email'}>{mode === 'login' ? t.auth.loginCta : t.auth.signupCta}</Button>
      </form>
      <p className="small muted">
        {mode === 'login' ? <>{t.auth.noAccount} <Link className="link" href={withNext('/signup', next)}>{t.common.signUp}</Link></>
          : <>{t.auth.haveAccount} <Link className="link" href={withNext('/login', next)}>{t.common.logIn}</Link></>}
      </p>
    </div>
  );
}
