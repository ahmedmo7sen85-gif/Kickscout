import 'server-only';
import { publicEnv } from './env';
import type { VideoView } from './types';

/**
 * Server-side, unauthenticated reads used only for SEO metadata. Failures return null so a page
 * still renders (and shows its own client-side state) when the API is unreachable.
 */
export async function fetchPublicVideo(id: string): Promise<VideoView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    const res = await fetch(`${publicEnv.apiUrl}/v1/videos/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2500),
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as VideoView;
  } catch {
    return null;
  }
}
