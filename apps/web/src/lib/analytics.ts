/**
 * Client-side product analytics: a small batcher for the browser events the API allows
 * (`CLIENT_EVENT_NAMES` in @fp/contracts). The server re-validates everything, applies the
 * person's analytics opt-out and strips minors' identifying properties; this side only keeps
 * requests few and never sends raw URLs, query strings, handles or ids in paths.
 */
import type { ClientEventName, TrackEventsRequest } from './types';

type Event = TrackEventsRequest['events'][number];
const MAX_BATCH = 20;

/** Known dynamic routes: the real segment is replaced by the route's parameter name. */
const DYNAMIC: [RegExp, string][] = [
  [/^\/u\/[^/]+$/, '/u/[handle]'],
  [/^\/v\/[^/]+$/, '/v/[id]'],
  [/^\/challenges\/[^/]+$/, '/challenges/[slug]'],
  [/^\/org\/(?!new$|invite$)[^/]+$/, '/org/[id]'],
  [/^\/scout\/shortlists\/[^/]+$/, '/scout/shortlists/[id]'],
  [/^\/legal\/(?!takedown$|counter-notice$)[^/]+$/, '/legal/[slug]'],
];

/**
 * The route template for a pathname (`/u/ahmed` → `/u/[handle]`). Anything that does not look
 * like a plain known route collapses to `/other`, so nothing user-specific can leak.
 */
export function routeTemplate(pathname: string): string {
  const path = (pathname.split(/[?#]/)[0] || '/').replace(/\/+$/, '') || '/';
  for (const [re, template] of DYNAMIC) if (re.test(path)) return template;
  return /^\/[a-z0-9\-/]*$/.test(path) && path.length <= 100 ? path : '/other';
}

/** The browser asked not to be tracked (Global Privacy Control or Do Not Track). */
export function browserOptedOut(nav: { doNotTrack?: string | null; globalPrivacyControl?: boolean } | undefined): boolean {
  if (!nav) return false;
  return nav.globalPrivacyControl === true || nav.doNotTrack === '1';
}

export interface EventBatcher {
  track: (name: ClientEventName, properties: Record<string, unknown>) => void;
  flush: () => Promise<void>;
  pending: () => number;
}

/**
 * Collects events and sends them in one request after `delayMs`, or at once when the batch is
 * full. Sending failures are swallowed: analytics must never break the page.
 */
export function createEventBatcher(send: (b: TrackEventsRequest) => Promise<unknown>, opts: { delayMs?: number; disabled?: () => boolean } = {}): EventBatcher {
  const delay = opts.delayMs ?? 3000;
  let queue: Event[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    while (queue.length) {
      const events = queue.slice(0, MAX_BATCH);
      queue = queue.slice(MAX_BATCH);
      try { await send({ events }); } catch { /* dropped on purpose */ }
    }
  }

  return {
    track(name, properties) {
      if (opts.disabled?.()) return;
      queue.push({ name, properties });
      if (queue.length >= MAX_BATCH) void flush();
      else if (!timer) timer = setTimeout(() => { void flush(); }, delay);
    },
    flush,
    pending: () => queue.length,
  };
}
