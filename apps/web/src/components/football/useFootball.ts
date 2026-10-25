'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isApiError } from '@/lib/api';

/**
 * Loads football data and keeps the last good answer on screen while it refreshes, so a live page
 * never flashes back to a skeleton. `refreshMs` re-fetches on an interval only while the tab is
 * visible and the browser is online (shared server cache: this does not add provider calls).
 */
export function useFootball<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[], opts: { refreshMs?: number | null; enabled?: boolean } = {}) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const enabled = opts.enabled ?? true;

  const run = useCallback(async (signal: AbortSignal, keep: boolean) => {
    if (!keep) {
      setLoading(true);
      setData(undefined);
    }
    try {
      const d = await loadRef.current(signal);
      if (signal.aborted) return;
      setData(d);
      setError(undefined);
    } catch (e) {
      if (signal.aborted) return;
      setError(isApiError(e) ? e : new ApiError({ status: 0, code: 'INTERNAL', title: e instanceof Error ? e.message : 'Error' }));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    void run(ctrl.signal, false);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const refreshMs = opts.refreshMs ?? null;
  useEffect(() => {
    if (!enabled || !refreshMs) return;
    const ctrl = new AbortController();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void run(ctrl.signal, true);
    }, refreshMs);
    return () => { window.clearInterval(id); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMs, enabled, ...deps]);

  const retry = useCallback(() => {
    const ctrl = new AbortController();
    void run(ctrl.signal, false);
  }, [run]);

  return { data, error, loading, online, retry };
}
