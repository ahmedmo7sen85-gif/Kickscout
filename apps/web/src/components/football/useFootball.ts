'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isApiError } from '@/lib/api';

/**
 * Loads football data and keeps the last good answer on screen while it refreshes, so a live page
 * never flashes back to a skeleton. `refreshMs` re-fetches on an interval only while the tab is
 * visible and the browser is online (shared server cache: this does not add provider calls); a tab
 * that comes back after a refresh was due loads at once. A refresh never overlaps a running one.
 */
export function useFootball<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[], opts: { refreshMs?: number | null; enabled?: boolean } = {}) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const busy = useRef(false);
  const loadedAt = useRef(0);
  const enabled = opts.enabled ?? true;

  const run = useCallback(async (signal: AbortSignal, keep: boolean) => {
    if (!keep) {
      setLoading(true);
      setData(undefined);
    }
    busy.current = true;
    try {
      const d = await loadRef.current(signal);
      if (signal.aborted) return;
      setData(d);
      setError(undefined);
      loadedAt.current = Date.now();
    } catch (e) {
      if (signal.aborted) return;
      // The last good answer stays on screen; the error is reported next to it.
      setError(isApiError(e) ? e : new ApiError({ status: 0, code: 'INTERNAL', title: e instanceof Error ? e.message : 'Error' }));
    } finally {
      busy.current = false;
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
    const tick = () => {
      if (document.visibilityState === 'visible' && navigator.onLine && !busy.current) void run(ctrl.signal, true);
    };
    const id = window.setInterval(tick, refreshMs);
    const onVisible = () => { if (Date.now() - loadedAt.current >= refreshMs) tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVisible); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMs, enabled, ...deps]);

  const retry = useCallback(() => {
    const ctrl = new AbortController();
    void run(ctrl.signal, false);
  }, [run]);

  /** Loads again now and keeps the current answer on screen meanwhile. */
  const refresh = useCallback(() => {
    if (busy.current) return;
    const ctrl = new AbortController();
    void run(ctrl.signal, true);
  }, [run]);

  return { data, error, loading, online, retry, refresh };
}
