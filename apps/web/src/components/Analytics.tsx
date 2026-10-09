'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { browserOptedOut, createEventBatcher, routeTemplate } from '@/lib/analytics';
import type { ClientEventName } from '@/lib/types';

const batcher = createEventBatcher((b) => api.trackEvents(b), {
  disabled: () => typeof navigator === 'undefined' || browserOptedOut(navigator as Navigator & { globalPrivacyControl?: boolean }),
});

/** Records an allowed client event (see `CLIENT_EVENT_NAMES`). Never throws. */
export function trackClient(name: ClientEventName, properties: Record<string, unknown> = {}): void {
  batcher.track(name, properties);
}

/** Sends `page_viewed` with the route template on each navigation, and flushes when the tab is hidden. */
export function PageViewTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) trackClient('page_viewed', { path: routeTemplate(pathname) });
  }, [pathname]);
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') void batcher.flush(); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);
  return null;
}
