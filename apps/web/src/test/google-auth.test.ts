import { afterEach, describe, expect, it, vi } from 'vitest';
import { googleEnabled } from '@/components/AuthForm';

const respond = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

describe('googleEnabled', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the Google switch from the Supabase Auth settings', async () => {
    vi.stubGlobal('fetch', respond({ external: { google: false, email: true } }));
    expect(await googleEnabled()).toBe(false);
    vi.stubGlobal('fetch', respond({ external: { google: true } }));
    expect(await googleEnabled()).toBe(true);
  });

  it('is unknown (null) when the settings cannot be read, so sign-in is not blocked', async () => {
    vi.stubGlobal('fetch', respond({}, false));
    expect(await googleEnabled()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await googleEnabled()).toBeNull();
  });
});
