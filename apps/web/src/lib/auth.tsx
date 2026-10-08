'use client';

import type { Session } from '@supabase/supabase-js';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, isApiError, type ApiError } from './api';
import { authConfigured } from './env';
import { getSupabase } from './supabase';
import type { MeView } from './types';

export type AuthStatus = 'loading' | 'unconfigured' | 'signed_out' | 'signed_in';

interface AuthValue {
  status: AuthStatus;
  session: Session | null;
  /** Null while loading, when signed out, or before onboarding. */
  me: MeView | null;
  meError: ApiError | null;
  needsOnboarding: boolean;
  refreshMe: () => Promise<void>;
  signOut: () => Promise<void>;
  /** UI convenience only; the API decides what each role may do. */
  isScout: boolean;
  isStaff: boolean;
  isPlayer: boolean;
}

const AuthContext = createContext<AuthValue | null>(null);
const NO_REDIRECT = ['/onboarding', '/login', '/signup', '/auth', '/guardian'];

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [status, setStatus] = useState<AuthStatus>(authConfigured ? 'loading' : 'unconfigured');
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<MeView | null>(null);
  const [meError, setMeError] = useState<ApiError | null>(null);

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return;
    api.setTokenGetter(async () => (await sb.auth.getSession()).data.session?.access_token ?? null);
    let active = true;
    void sb.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setStatus(data.session ? 'signed_in' : 'signed_out');
    });
    const { data: sub } = sb.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setStatus(s ? 'signed_in' : 'signed_out');
      if (!s) setMe(null);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me());
      setMeError(null);
    } catch (e) {
      setMe(null);
      setMeError(isApiError(e) ? e : null);
    }
  }, []);

  const token = session?.access_token;
  useEffect(() => {
    if (status === 'signed_in' && token) void refreshMe();
  }, [status, token, refreshMe]);

  const needsOnboarding = meError?.code === 'NOT_REGISTERED';
  useEffect(() => {
    if (needsOnboarding && !NO_REDIRECT.some((p) => pathname.startsWith(p))) router.replace('/onboarding');
  }, [needsOnboarding, pathname, router]);

  const signOut = useCallback(async () => {
    await getSupabase()?.auth.signOut();
    setMe(null);
    router.push('/');
  }, [router]);

  const value = useMemo<AuthValue>(() => {
    const roles = me?.roles ?? [];
    return {
      status, session, me, meError, needsOnboarding, refreshMe, signOut,
      isScout: roles.includes('scout'),
      isStaff: roles.includes('admin') || roles.includes('moderator'),
      isPlayer: roles.includes('player'),
    };
  }, [status, session, me, meError, needsOnboarding, refreshMe, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
