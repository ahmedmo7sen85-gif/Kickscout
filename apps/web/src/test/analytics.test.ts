import { describe, expect, it, vi } from 'vitest';
import { CLIENT_EVENT_NAMES, prepareEvent } from '@fp/contracts';
import { browserOptedOut, createEventBatcher, routeTemplate } from '@/lib/analytics';
import type { TrackEventsRequest } from '@/lib/types';

describe('client analytics', () => {
  it('sends route templates, never handles, ids or query strings', () => {
    expect(routeTemplate('/u/ahmed.10')).toBe('/u/[handle]');
    expect(routeTemplate('/v/0192e000-0000-7000-8000-000000000001?t=3')).toBe('/v/[id]');
    expect(routeTemplate('/challenges/elastico-week')).toBe('/challenges/[slug]');
    expect(routeTemplate('/org/new')).toBe('/org/new');
    expect(routeTemplate('/org/0192e000-0000-7000-8000-000000000001')).toBe('/org/[id]');
    expect(routeTemplate('/legal/takedown')).toBe('/legal/takedown');
    expect(routeTemplate('/legal/privacy')).toBe('/legal/[slug]');
    expect(routeTemplate('/discover/')).toBe('/discover');
    expect(routeTemplate('/search?q=ahmed')).toBe('/search');
    expect(routeTemplate('/Weird Path')).toBe('/other');
    // Whatever the template, the server accepts it as a page_viewed path.
    for (const p of ['/u/x', '/v/y', '/other', '/', '/scout/shortlists/z']) {
      expect(prepareEvent('page_viewed', { path: routeTemplate(p) }, { source: 'client', optedOut: false, minor: false }).record, p).toBe(true);
    }
    expect(CLIENT_EVENT_NAMES).toContain('page_viewed');
  });

  it('honours Global Privacy Control and Do Not Track', () => {
    expect(browserOptedOut({ globalPrivacyControl: true })).toBe(true);
    expect(browserOptedOut({ doNotTrack: '1' })).toBe(true);
    expect(browserOptedOut({ doNotTrack: 'unspecified' })).toBe(false);
    expect(browserOptedOut(undefined)).toBe(false);
  });

  it('batches events, caps a request at 20 and swallows send failures', async () => {
    vi.useFakeTimers();
    const sent: TrackEventsRequest[] = [];
    const b = createEventBatcher(async (r) => { sent.push(r); if (sent.length === 1) throw new Error('offline'); }, { delayMs: 1000 });
    for (let i = 0; i < 25; i++) b.track('page_viewed', { path: '/' });
    await vi.runAllTimersAsync();
    expect(sent.map((r) => r.events.length)).toEqual([20, 5]);
    expect(b.pending()).toBe(0);
    b.track('cta_clicked', { cta: 'show_skill' });
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(3);
    vi.useRealTimers();
  });

  it('records nothing while disabled', async () => {
    const send = vi.fn(async () => undefined);
    const b = createEventBatcher(send, { disabled: () => true });
    b.track('page_viewed', { path: '/' });
    await b.flush();
    expect(send).not.toHaveBeenCalled();
  });
});
