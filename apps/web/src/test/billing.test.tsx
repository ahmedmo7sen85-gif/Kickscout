import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BillingSummary } from '@/components/billing/BillingSummary';
import { PlanCard, type PlanCardProps } from '@/components/billing/PlanCard';
import { ApiError, createApiClient } from '@/lib/api';
import { formatPrice, limitLines, yearlySavingPct } from '@/lib/billing';
import { en } from '@/lib/i18n/en';
import { createI18nValue, I18nContext } from '@/lib/i18n/provider';
import type { EntitlementsView, Locale, PlanView } from '@/lib/types';

// Shaped exactly like GET /v1/plans for the seeded plans.
const limits = { maxVideoSeconds: 60, maxActiveVideos: 20, maxUploadsPerDay: 10, scoutSearchesPerMonth: 0, shortlistSlots: 0, seats: 1 };
const playerFree: PlanView = {
  key: 'player_free', audience: 'player', tier: 'free', name: { en: 'Player Free', ar: 'اللاعب المجاني' }, description: { en: 'Post your skills.', ar: 'انشر مهاراتك.' },
  checkout: 'none', trialDays: 0, prices: [], features: [], limits,
};
const playerPro: PlanView = {
  key: 'player_pro', audience: 'player', tier: 'pro', name: { en: 'Player Pro', ar: 'اللاعب برو' }, description: { en: 'Longer clips.', ar: 'مقاطع أطول.' },
  checkout: 'self_serve', trialDays: 7,
  prices: [{ currency: 'USD', interval: 'month', amountMinor: 499 }, { currency: 'USD', interval: 'year', amountMinor: 4900 }],
  features: [{ key: 'FEATURE_EXTENDED_UPLOADS', status: 'live' }, { key: 'FEATURE_PRO_ANALYTICS', status: 'coming_soon' }],
  limits: { ...limits, maxVideoSeconds: 180, maxActiveVideos: 100, maxUploadsPerDay: 30 },
};
const clubPro: PlanView = {
  key: 'club_pro', audience: 'organization', tier: 'club', name: { en: 'Club Pro', ar: 'النادي برو' }, description: { en: 'Clubs.', ar: 'الأندية.' },
  checkout: 'self_serve', trialDays: 0, prices: [{ currency: 'USD', interval: 'month', amountMinor: 24900 }], features: [],
  limits: { ...limits, scoutSearchesPerMonth: null, shortlistSlots: null, seats: 10 },
};
const enterprise: PlanView = { ...clubPro, key: 'enterprise', tier: 'enterprise', name: { en: 'Enterprise', ar: 'المؤسسات الكبرى' }, checkout: 'contact_sales', prices: [] };

const NOW = new Date('2026-10-08T12:00:00Z');
function card(plan: PlanView, over: Partial<PlanCardProps> = {}, locale: Locale = 'en') {
  return renderToStaticMarkup(
    <I18nContext.Provider value={createI18nValue(locale)}>
      <PlanCard plan={plan} interval="month" now={NOW} paymentsEnabled signedIn {...over} />
    </I18nContext.Provider>,
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('plan cards', () => {
  it('shows the monthly price, the trial with the date of the first charge, and the renewal terms', () => {
    const t = text(card(playerPro));
    expect(t).toContain('$4.99 per month');
    expect(t).toContain('7-day free trial for first-time subscribers. Nothing is charged until Oct 15, 2026');
    expect(t).toContain('Then $4.99 per month, renewing automatically until you cancel.');
    expect(t).toContain('Start 7-day free trial');
    expect(t).toContain('Clips up to 180 seconds');
    expect(t).toContain('Up to 100 videos on your profile');
  });

  it('shows the yearly price with an honest saving, and monthly-only plans as such', () => {
    const t = text(card(playerPro, { interval: 'year' }));
    expect(t).toContain('$49 per year');
    expect(t).toContain('Save 18% compared with paying monthly');
    const club = text(card(clubPro, { interval: 'year' }));
    expect(club).toContain('$249 per month');
    expect(club).toContain('Billed monthly only');
    expect(club).toContain('$249 per month, renewing automatically until you cancel.');
    expect(club).toContain('Unlimited scout searches');
    expect(club).toContain('Up to 10 team seats');
  });

  it('labels features that are not built yet as coming soon', () => {
    const html = card(playerPro);
    expect(text(html)).toMatch(/Pro analytics Coming soon/);
    expect(text(html)).not.toMatch(/Longer clips and more videos Coming soon/);
  });

  it('says payments are not enabled instead of offering a working button', () => {
    const html = card(playerPro, { paymentsEnabled: false });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="off-player_pro"/);
    expect(text(html)).toContain('Payments are not enabled yet');
  });

  it('shows free and contact-sales plans without a checkout, and pre-checks nothing', () => {
    const free = card(playerFree, { signedIn: false });
    expect(text(free)).toContain('Free');
    expect(text(free)).toContain('Clips up to 60 seconds');
    expect(free).toContain('href="/signup"');
    const ent = card(enterprise);
    expect(text(ent)).toContain('Custom pricing');
    expect(text(ent)).toContain('Sales contact details are coming soon.');
    expect(card(enterprise, { salesEmail: 'sales@example.com' })).toContain('href="mailto:sales@example.com?subject=KICKSCOUT%20Enterprise"');
    for (const html of [free, ent, card(playerPro), card(playerPro, { interval: 'year' })]) expect(html).not.toMatch(/checked/);
  });

  it('asks signed-out visitors to log in before subscribing', () => {
    const html = card(playerPro, { signedIn: false });
    expect(html).toContain('href="/login"');
    expect(text(html)).toContain('Log in to subscribe');
  });

  it('renders in Arabic', () => {
    const t = text(card(playerPro, {}, 'ar'));
    expect(t).toContain('اللاعب برو');
    expect(t).toContain('تجربة مجانية لمدة 7 يوم للمشتركين الجدد');
    expect(t).toContain('قريبًا');
  });
});

describe('billing summary in settings', () => {
  const base: EntitlementsView = {
    plans: ['player_free'], features: [], limits,
    usage: { activeVideos: 3, uploadsToday: 1, scoutSearchesThisMonth: 0, shortlistSlotsUsed: 0, searchesResetAt: '2026-11-01T00:00:00.000Z' },
    subscriptions: [], hasBillingAccount: false, paymentsEnabled: true,
  };
  const sub = { planKey: 'player_pro', planName: playerPro.name, interval: 'month' as const, currency: 'USD', amountMinor: 499, trialEnd: null, currentPeriodEnd: '2026-11-08T12:00:00.000Z', cancelAtPeriodEnd: false, grantsAccess: true, paidByOther: false };
  const render = (data: EntitlementsView, extra: { paymentsOff?: boolean; confirming?: boolean; roles?: string[] } = {}) => text(renderToStaticMarkup(
    <I18nContext.Provider value={createI18nValue('en')}>
      <BillingSummary data={data} roles={extra.roles ?? ['player']} paymentsOff={extra.paymentsOff} confirming={extra.confirming} />
    </I18nContext.Provider>,
  ));

  it('shows the free plan and the limits in effect', () => {
    const t = render(base);
    expect(t).toContain('Free plan');
    expect(t).toContain('3 of 20 videos');
    expect(t).toContain('See plans');
    expect(t).not.toContain('Manage or cancel');
  });

  it('shows the trial end date and what will be charged then', () => {
    const t = render({ ...base, hasBillingAccount: true, subscriptions: [{ ...sub, status: 'trialing', trialEnd: '2026-10-15T12:00:00.000Z' }] });
    expect(t).toContain('Free trial');
    expect(t).toContain('Free trial ends Oct 15, 2026. You will be charged $4.99 then unless you cancel before.');
    expect(t).toContain('Manage or cancel');
  });

  it('shows renewal, scheduled cancellation and failed payment plainly', () => {
    expect(render({ ...base, subscriptions: [{ ...sub, status: 'active' }] })).toContain('Renews Nov 8, 2026 at $4.99.');
    expect(render({ ...base, subscriptions: [{ ...sub, status: 'active', cancelAtPeriodEnd: true }] })).toContain('Cancelled. Your plan stays active until Nov 8, 2026 and will not renew.');
    expect(render({ ...base, subscriptions: [{ ...sub, status: 'past_due' }] })).toContain('Your last payment did not go through.');
  });

  it('never shows success on return from checkout; it waits for confirmation', () => {
    const t = render(base, { confirming: true });
    expect(t).toContain('waiting for the payment provider to confirm your payment');
    expect(t).toContain('Free plan');
  });

  it('says payments are not enabled when the API reports it', () => {
    expect(render({ ...base, paymentsEnabled: false })).toContain('Payments are not enabled yet');
    expect(render({ ...base, hasBillingAccount: true }, { paymentsOff: true })).toContain('Payments are not enabled yet');
  });

  it('shows scout quotas for scouts', () => {
    const t = render({ ...base, limits: { ...limits, scoutSearchesPerMonth: 20, shortlistSlots: 10 }, usage: { ...base.usage, scoutSearchesThisMonth: 7, shortlistSlotsUsed: 4 } }, { roles: ['fan', 'scout'] });
    expect(t).toContain('7 of 20 scout searches this month');
    expect(t).toContain('4 of 10 shortlist slots');
  });
});

describe('billing helpers and client', () => {
  it('formats minor units in the plan currency', () => {
    expect(formatPrice(499, 'USD', 'en')).toBe('$4.99');
    expect(formatPrice(24900, 'USD', 'en')).toBe('$249');
    expect(formatPrice(500, 'JPY', 'en')).toBe('¥500');
    expect(yearlySavingPct(playerPro)).toBe(18);
    expect(yearlySavingPct(clubPro)).toBeNull();
    expect(limitLines(playerFree, en)).toEqual(['Clips up to 60 seconds', 'Up to 20 videos on your profile', '10 uploads per day']);
  });

  it('reads plans from the API and reports 503 BILLING_NOT_CONFIGURED at checkout', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/v1/plans')
      ? new Response(JSON.stringify({ currency: 'USD', paymentsEnabled: false, items: [playerPro] }), { status: 200 })
      : new Response(JSON.stringify({ type: 'urn:x', title: 'Service Unavailable', status: 503, code: 'BILLING_NOT_CONFIGURED', detail: 'payments are not enabled yet' }), { status: 503, headers: { 'Content-Type': 'application/problem+json' } }));
    const client = createApiClient({ baseUrl: 'https://api.test', getToken: () => 't', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await client.plans({ currency: 'USD' })).items[0]!.key).toBe('player_pro');
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://api.test/v1/plans?currency=USD');
    const err = (await client.checkout({ planKey: 'player_pro', interval: 'month' }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(err.isBillingOff).toBe(true);
    expect(new ApiError({ status: 503, code: 'INTERNAL', title: 'x' }).isBillingOff).toBe(false);
  });
});
