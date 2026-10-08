'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from './auth';
import { errorMessage } from './errors';
import { useI18n } from './i18n/provider';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * Wraps an action that needs a signed-in user: prompts to log in when signed out and shows the
 * API's friendly error otherwise. Returns true on success.
 */
export function useAuthedAction() {
  const { status } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  return useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (status !== 'signed_in') {
      toast.show(t.feed.loginToAct, { action: { label: t.common.logIn, href: '/login' } });
      return false;
    }
    try {
      await fn();
      return true;
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
      return false;
    }
  }, [status, t, toast]);
}
