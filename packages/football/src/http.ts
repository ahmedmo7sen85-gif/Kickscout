import { ProviderError } from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Extra attempts after a network error or 5xx (never after 4xx). */
  retries?: number;
  userAgent?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfter(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 3600);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.min(3600, Math.round((at - Date.now()) / 1000))) : null;
}

/**
 * GETs JSON with a timeout and a small retry budget. 404 returns null (the caller decides what a
 * missing resource means); 429 and other failures become a `ProviderError` the cache can act on.
 * Response bodies are never logged: they may be large and are third-party data.
 */
export async function getJson(url: string, headers: Record<string, string>, opts: HttpOptions = {}, signal?: AbortSignal): Promise<unknown | null> {
  const doFetch = opts.fetchImpl ?? ((i: string, init?: RequestInit) => fetch(i, init));
  const attempts = 1 + (opts.retries ?? 1);
  let last: ProviderError | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(250 * 2 ** (i - 1));
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 8000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(url, { headers: { Accept: 'application/json', ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}), ...headers }, signal: combined });
    } catch (e) {
      if (signal?.aborted) throw e;
      last = new ProviderError(timeout.aborted ? 'timeout' : 'unavailable', timeout.aborted ? 'provider timed out' : 'provider unreachable');
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 429) throw new ProviderError('rate_limited', 'provider rate limit reached', retryAfter(res));
    if (res.status === 401 || res.status === 403) throw new ProviderError('not_configured', `provider refused the request (${res.status})`);
    if (res.status >= 500) {
      last = new ProviderError('unavailable', `provider error ${res.status}`);
      continue;
    }
    if (!res.ok) {
      // Other 4xx: the request itself is not answerable (unknown slug, unsupported filter).
      if (res.status === 400 || res.status === 422) return null;
      throw new ProviderError('bad_response', `unexpected provider status ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new ProviderError('bad_response', 'provider sent invalid JSON');
    }
  }
  throw last ?? new ProviderError('unavailable', 'provider unreachable');
}

/** Lower-case ASCII slug for names that have no provider id. */
export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Integer or null from a provider value ("1", 1, null, ""). */
export function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** ISO 8601 UTC, or null when the value is not a real timestamp. */
export function toIsoUtc(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}
