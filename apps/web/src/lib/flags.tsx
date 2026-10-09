'use client';

/**
 * Feature flags in the browser. GET /v1/flags returns the client-visible flags already evaluated
 * for the caller (role, country and percentage bucket are decided by the server). The result is
 * fetched once per sign-in state and shared; until it arrives, and on any error, every flag is off.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';

export const KNOWN_FLAGS = ['nl_scout_search', 'for_you_personalization', 'hls_streaming'] as const;
export type KnownFlag = (typeof KNOWN_FLAGS)[number];

const FlagsContext = createContext<Record<string, boolean>>({});

export function FlagsProvider({ children, initial = {} }: { children: ReactNode; initial?: Record<string, boolean> }) {
  const { status, session } = useAuth();
  const [flags, setFlags] = useState<Record<string, boolean>>(initial);
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (status === 'loading') return;
    const ctrl = new AbortController();
    api.flags(ctrl.signal).then((r) => setFlags(r.flags), () => setFlags({}));
    return () => ctrl.abort();
  }, [status, userId]);

  return <FlagsContext.Provider value={flags}>{children}</FlagsContext.Provider>;
}

/** Whether a flag is on for the current viewer. Off when unknown, loading or failed. */
export function useFlag(key: KnownFlag | (string & {})): boolean {
  return useContext(FlagsContext)[key] === true;
}

export { FlagsContext };
