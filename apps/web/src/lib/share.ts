'use client';

/** Web Share API when available, otherwise copy the link. Returns what happened. */
export async function shareLink(url: string, title: string, text?: string): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (nav?.share) {
    try {
      await nav.share({ url, title, text });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await nav?.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'failed';
  }
}

export function absoluteUrl(path: string): string {
  return typeof window === 'undefined' ? path : new URL(path, window.location.origin).toString();
}
