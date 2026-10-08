'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { ApiError, isApiError } from './api';

export type ApiState<T> =
  | { status: 'loading'; data: undefined; error: undefined }
  | { status: 'success'; data: T; error: undefined }
  | { status: 'error'; data: undefined; error: ApiError };

/**
 * Loads data on mount and whenever `deps` change, exposing loading / success / error and a retry.
 * NOT_REGISTERED sends the user to onboarding, as the API asks.
 */
export function useApi<T>(load: (signal: AbortSignal) => Promise<T>, deps: DependencyList, opts: { enabled?: boolean } = {}) {
  const router = useRouter();
  const enabled = opts.enabled ?? true;
  const [state, setState] = useState<ApiState<T>>({ status: 'loading', data: undefined, error: undefined });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    setState({ status: 'loading', data: undefined, error: undefined });
    loadRef.current(ctrl.signal).then(
      (data) => { if (!ctrl.signal.aborted) setState({ status: 'success', data, error: undefined }); },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        const err = isApiError(e) ? e : new ApiError({ status: 0, code: 'INTERNAL', title: e instanceof Error ? e.message : 'Error' });
        if (err.code === 'NOT_REGISTERED') router.replace('/onboarding');
        setState({ status: 'error', data: undefined, error: err });
      },
    );
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((fn: (d: T) => T) => {
    setState((s) => (s.status === 'success' ? { ...s, data: fn(s.data) } : s));
  }, []);
  return { ...state, retry, setData };
}
