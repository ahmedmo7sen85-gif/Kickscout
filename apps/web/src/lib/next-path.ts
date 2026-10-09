/**
 * Where to send someone after they sign in or finish onboarding, carried as `?next=`.
 * Only same-site paths are accepted ("/guardian/accept?token=…"), never "//host" or a full URL,
 * so the parameter cannot be used as an open redirect.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

/** The current page's `?next=`, or null (always null on the server). */
export function readNext(): string | null {
  if (typeof window === 'undefined') return null;
  return safeNext(new URLSearchParams(window.location.search).get('next'));
}

/** `href` with `?next=` appended when there is somewhere to come back to. */
export function withNext(href: string, next: string | null): string {
  return next ? `${href}${href.includes('?') ? '&' : '?'}next=${encodeURIComponent(next)}` : href;
}
