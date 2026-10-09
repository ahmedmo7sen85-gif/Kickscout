import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { feed, MEDIA, posterSvg, radar } from './fixtures';

const SHOTS = new URL('../.screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const SECTIONS = ['hero', 'discover', 'how', 'showcase', 'radar', 'players', 'scouts', 'community', 'challenges', 'safety', 'final'];

/** The API is unreachable in every test unless a test mocks a route explicitly. */
async function apiDown(page: Page) {
  await page.route(/\/v1\//, (r) => r.abort('connectionrefused'));
  await page.route(`${MEDIA}/**`, (r) => {
    const m = /t(\d+)\.svg$/.exec(r.request().url());
    return m ? r.fulfill({ status: 200, contentType: 'image/svg+xml', body: posterSvg(Number(m[1])) }) : r.fulfill({ status: 404, body: '' });
  });
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

test.beforeEach(async ({ page }) => { await apiDown(page); });

test('landing renders all 11 sections in order with both CTAs', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const order = await page.locator('[data-section]').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')));
  expect(order).toEqual(SECTIONS);
  const h1 = page.locator('h1#hero-title');
  await expect(h1).toContainText('YOUR SKILL.');
  await expect(h1).toContainText('YOUR MOMENT.');
  await expect(h1).toContainText('GET DISCOVERED.');
  await expect(page.getByText('Show your football skills. Discover rising talent. Get noticed.')).toBeVisible();
  await expect(page.getByTestId('cta-show')).toHaveText('SHOW YOUR SKILL');
  await expect(page.getByTestId('cta-discover')).toHaveText('DISCOVER TALENTS');
  await expect(page.locator('#final')).toContainText('THE NEXT FOOTBALL STAR MIGHT BE');
  await expect(page.locator('#final')).toContainText('SCROLLING RIGHT NOW.');
  await expect(page.locator('#final').getByRole('link', { name: 'SHOW YOUR SKILL' })).toBeVisible();
  // Hero video never has sound and loops inline.
  const hero = page.getByTestId('hero-media').locator('video');
  if (await hero.count()) {
    expect(await hero.evaluate((v: HTMLVideoElement) => v.muted && v.loop && v.playsInline)).toBe(true);
  }
  // Every promo frame carries the AI-generated label.
  expect(await page.locator('.frame .badge--ai').count()).toBe(19 + 4 + 3);
  expect(errors).toEqual([]);
});

test('landing screenshots at 390 and 1440', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${SHOTS}landing-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${SHOTS}landing-1440.png`, fullPage: true });
});

test('Arabic locale cookie sets dir="rtl" and lang="ar"', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'ks_locale', value: 'ar', url: baseURL! }]);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByTestId('cta-show')).toHaveText('اعرض مهارتك');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}landing-ar-390.png` });
});

test('mobile bottom nav has the five items at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/discover');
  const nav = page.getByTestId('bottom-nav');
  await expect(nav).toBeVisible();
  const labels = await nav.getByRole('link').allInnerTexts();
  expect(labels.map((l) => l.trim())).toEqual(['Home', 'Discover', 'Upload', 'Talent Radar', 'Profile']);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(nav).toBeHidden();
  const top = page.getByRole('navigation', { name: 'Main' });
  for (const name of ['Home', 'Discover', 'Talent Radar', 'Challenges', 'Play', 'Upload', 'For Players', 'For Scouts', 'Notifications', 'Profile']) {
    await expect(top.getByRole('link', { name, exact: true })).toBeVisible();
  }
});

for (const path of ['/home', '/discover', '/radar', '/challenges', '/challenges/elastico', '/search?q=elastico',
  '/u/demo_winger', '/v/00000000-0000-4000-8000-000000000101']) {
  test(`shows an error state, not a crash, when the API is unreachable: ${path}`, async ({ page }) => {
    const errors = collectErrors(page);
    const res = await page.goto(path);
    expect(res?.status()).toBeLessThan(500);
    await expect(page.getByTestId('error-state').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
    await expect(page.getByText('This page hit the post')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('pages that need a session explain it instead of crashing', async ({ page }) => {
  for (const path of ['/scout', '/upload', '/settings', '/notifications', '/admin', '/login']) {
    const errors = collectErrors(page);
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByText('This page hit the post')).toHaveCount(0);
    expect(errors, path).toEqual([]);
  }
  await page.goto('/login');
  await expect(page.getByTestId('auth-not-configured')).toBeVisible();
});

test('screenshots: /home, /upload, /radar, /scout', async ({ page }) => {
  // Error state with the API down.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await expect(page.getByTestId('error-state')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}home-390-api-down.png`, fullPage: true });

  // The feed and radar with contract-validated fixtures.
  await page.route(/\/v1\/feed/, (r) => r.fulfill({ json: feed }));
  await page.route(/\/v1\/radar/, (r) => r.fulfill({ json: radar }));
  await page.goto('/home');
  await expect(page.getByTestId('feed')).toBeVisible();
  await expect(page.locator('.tag--ai').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}home-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/home');
  await expect(page.getByTestId('feed')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}home-1440.png` });

  await page.goto('/radar');
  await expect(page.getByTestId('radar-disclaimer')).toContainText('not ability');
  await expect(page.getByText('Trending because…').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}radar-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/radar');
  await expect(page.getByTestId('radar-disclaimer')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}radar-390.png`, fullPage: true });

  await page.goto('/upload');
  await expect(page.getByTestId('upload-step')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}upload-390.png`, fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/scout');
  await expect(page.getByTestId('scout-gate')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}scout-1440.png`, fullPage: true });
});
