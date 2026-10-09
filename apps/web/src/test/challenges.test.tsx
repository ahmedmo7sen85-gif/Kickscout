import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChallengeTile } from '@/app/discover/DiscoverView';
import { formatScore } from '@/app/challenges/[slug]/ChallengeDetail';
import { createApiClient, KNOWN_ERROR_CODES } from '@/lib/api';
import { ar } from '@/lib/i18n/ar';
import { en } from '@/lib/i18n/en';
import { createI18nValue, I18nContext } from '@/lib/i18n/provider';
import { buildSitemap, PRIVATE_PATHS } from '@/lib/seo';
import type { ChallengeView } from '@/lib/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => {} }), useSearchParams: () => new URLSearchParams() }));

const challenge: ChallengeView = {
  id: '0192e000-0000-7000-8000-0000000000c1', slug: 'juggling-king-oct', title: { en: 'Juggling King', ar: 'ملك تنطيط الكرة' },
  description: { en: 'Most touches.', ar: 'أكثر لمسات.' }, skill: 'juggling', hashtag: 'jugglingking', startsAt: '2026-10-01T00:00:00.000Z',
  endsAt: '2026-10-15T00:00:00.000Z', state: 'active', phase: 'open', format: 'weekly', category: 'ball_control', difficulty: 'beginner',
  ageGroups: ['u13', 'u16', 'u18', 'adult'], featured: true, reward: null, thumbnailUrl: null, timezone: 'UTC', participants: 12, entries: 4,
  votingEnabled: true, isDemo: false,
};
const nf = (n: number) => String(n);

describe('challenge UI', () => {
  it('formats scores in the rubric unit, times in seconds', () => {
    expect(formatScore(42, 'count', en, nf)).toBe('42 touches');
    expect(formatScore(12345, 'ms', en, nf)).toBe('12.35 s');
    expect(formatScore(7, 'hits', en, nf)).toBe('7 hits');
  });

  it('shows phase, level, category, deadline and counts on a card, in Arabic too', () => {
    const render = (locale: 'en' | 'ar') => renderToStaticMarkup(
      <I18nContext.Provider value={createI18nValue(locale)}><ChallengeTile c={challenge} reasons={['level']} /></I18nContext.Provider>,
    );
    const html = render('en');
    for (const s of ['Open', 'Beginner', 'Weekly', 'Ball control', '#jugglingking', 'Your next level', '12 players', '4 entries', 'href="/challenges/juggling-king-oct"']) expect(html).toContain(s);
    const rtl = render('ar');
    expect(rtl).toContain(ar.challenges.phases.open);
    expect(rtl).toContain('ملك تنطيط الكرة');
  });

  it('has a translated message for every challenge error code the API returns', () => {
    for (const code of KNOWN_ERROR_CODES) expect(en.errors[code], code).toBeTruthy();
  });

  it('votes with POST and takes a vote back with DELETE', async () => {
    const calls: { method: string; url: string }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) });
      return new Response(JSON.stringify({ counted: true, votesLeft: 2 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const api = createApiClient({ baseUrl: 'https://api.test', fetchImpl: fetchImpl as unknown as typeof fetch });
    await api.voteEntry('s1', true);
    await api.voteEntry('s1', false);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['POST /v1/challenge-submissions/s1/vote', 'DELETE /v1/challenge-submissions/s1/vote']);
  });

  it('lists indexable challenges in the sitemap and keeps judging out of crawlers', () => {
    const urls = buildSitemap('https://k.test', { profiles: [], videos: [], challenges: [{ slug: 'juggling-king-oct', updatedAt: '2026-10-02T00:00:00.000Z' }] }).map((e) => e.url);
    expect(urls).toContain('https://k.test/challenges/juggling-king-oct');
    expect(PRIVATE_PATHS).toContain('/judge');
  });
});
