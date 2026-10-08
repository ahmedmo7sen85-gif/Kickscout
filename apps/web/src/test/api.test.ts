import { describe, expect, it, vi } from 'vitest';
import { ApiError, buildQuery, createApiClient } from '@/lib/api';

function jsonResponse(body: unknown, status: number, contentType = 'application/json') {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

describe('API client', () => {
  it('attaches the bearer token and calls the right URL', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ items: [] }, 200));
    const api = createApiClient({ baseUrl: 'https://api.example.com/', getToken: () => 'tok_123', fetchImpl: fetchImpl as unknown as typeof fetch });
    await api.feed({ tab: 'trending' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.example.com/v1/feed?tab=trending');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok_123');
  });

  it('sends no Authorization header without a session, and JSON bodies with a content type', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: fetchImpl as unknown as typeof fetch });
    await api.like('00000000-0000-4000-8000-000000000001', true);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(init.method).toBe('PUT');
  });

  it('turns an RFC 9457 problem+json response into a typed ApiError', async () => {
    const problem = { type: 'https://errors.example/consent', title: 'Consent required', status: 403, code: 'CONSENT_REQUIRED', detail: 'public_profile consent missing', traceId: 'abc' };
    const fetchImpl = vi.fn(async () => jsonResponse(problem, 403, 'application/problem+json'));
    const api = createApiClient({ baseUrl: 'https://api.example.com', getToken: async () => 't', fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await api.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.code).toBe('CONSENT_REQUIRED');
    expect(e.status).toBe(403);
    expect(e.title).toBe('Consent required');
    expect(e.detail).toBe('public_profile consent missing');
    expect(e.traceId).toBe('abc');
    expect(e.isForbidden).toBe(true);
  });

  it('keeps field errors from validation problems', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ type: 'about:blank', title: 'Bad', status: 400, code: 'VALIDATION_FAILED', errors: [{ path: 'handle', message: 'taken' }] }, 400, 'application/problem+json'));
    const api = createApiClient({ baseUrl: 'https://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const e = (await api.register({ handle: 'abc', displayName: 'A', dob: '2000-01-01', countryCode: 'EG', roles: ['fan'] }).catch((x: unknown) => x)) as ApiError;
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.fieldErrors).toEqual([{ path: 'handle', message: 'taken' }]);
  });

  it('maps non-problem failures and unreachable servers to stable codes', async () => {
    const html = vi.fn(async () => new Response('<html>nope</html>', { status: 401 }));
    const e1 = (await createApiClient({ baseUrl: 'https://x', fetchImpl: html as unknown as typeof fetch }).me().catch((x: unknown) => x)) as ApiError;
    expect(e1.code).toBe('UNAUTHENTICATED');
    expect(e1.isAuth).toBe(true);

    const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const e2 = (await createApiClient({ baseUrl: 'https://x', fetchImpl: down as unknown as typeof fetch }).discover().catch((x: unknown) => x)) as ApiError;
    expect(e2).toBeInstanceOf(ApiError);
    expect(e2.code).toBe('NETWORK_ERROR');
    expect(e2.isNetwork).toBe(true);
  });

  it('builds query strings without empty values', () => {
    expect(buildQuery({ a: 'x', b: undefined, c: '', d: 0, e: true })).toBe('?a=x&d=0&e=true');
    expect(buildQuery({})).toBe('');
  });
});
