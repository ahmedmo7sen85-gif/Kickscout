/**
 * WCAG 2.2 AA basics checked without a browser: text contrast of the colour tokens (1.4.3),
 * minimum target size of the small controls (2.5.8), a visible focus indicator (2.4.7), and
 * labelled, language-tagged controls in components added in Phase E1 (1.3.1, 3.1.2, 4.1.2).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BarChart, MetricsReport } from '@/app/admin/metrics/MetricsView';
import { LocaleSwitch } from '@/components/nav/LocaleSwitch';
import { createI18nValue, I18nContext } from '@/lib/i18n/provider';
import type { AdminMetrics, Locale } from '@/lib/types';

const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');

function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token --${name} not found`);
  const v = m[1]!.trim();
  const ref = v.match(/^var\(--([\w-]+)\)$/);
  return ref ? token(ref[1]!) : v;
}
function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
/** The first `prop: Npx` inside the rule whose selector is exactly `selector`. */
function px(selector: string, prop: string): number {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = css.match(new RegExp(`(^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`rule ${selector} not found`);
  const m = rule[2]!.match(new RegExp(`(?:^|;|\\s)${prop}:\\s*(\\d+)px`));
  if (!m) throw new Error(`${prop} not set on ${selector}`);
  return Number(m[1]);
}

function render(node: React.ReactNode, locale: Locale = 'en') {
  return renderToStaticMarkup(<I18nContext.Provider value={createI18nValue(locale)}>{node}</I18nContext.Provider>);
}

describe('accessibility: colour and size', () => {
  it('text tokens reach 4.5:1 on every surface', () => {
    const backgrounds = ['bg', 'surface', 'surface-2'].map(token);
    for (const fg of ['text', 'text-2', 'muted', 'accent'].map(token)) {
      for (const bg of backgrounds) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(token('on-accent'), token('accent'))).toBeGreaterThanOrEqual(4.5);
  });

  it('small controls are at least 24 by 24 CSS pixels', () => {
    expect(px('.tag__x', 'inline-size')).toBeGreaterThanOrEqual(24);
    expect(px('.tag__x', 'block-size')).toBeGreaterThanOrEqual(24);
    expect(px(".trim__bar input[type='range']::-webkit-slider-thumb", 'inline-size')).toBeGreaterThanOrEqual(24);
    expect(px(".trim__bar input[type='range']::-moz-range-thumb", 'inline-size')).toBeGreaterThanOrEqual(24);
    expect(px('.locale-switch__select', 'min-block-size')).toBeGreaterThanOrEqual(24);
    expect(px('.input--sm', 'min-block-size')).toBeGreaterThanOrEqual(24);
  });

  it('keeps a visible focus outline', () => {
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*3px solid/);
    expect(css).not.toMatch(/outline:\s*(none|0)\b/);
  });
});

describe('accessibility: new components', () => {
  it('the locale switcher is a labelled select with every locale in its own language', () => {
    const html = render(<LocaleSwitch />, 'fr');
    const id = html.match(/<select id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<label for="${id}" class="sr-only">Changer de langue</label>`);
    for (const [l, name] of [['en', 'English'], ['ar', 'العربية'], ['es', 'Español'], ['pt', 'Português'], ['fr', 'Français']]) {
      expect(html).toMatch(new RegExp(`<option value="${l}" lang="${l}"[^>]*>${name}</option>`));
    }
    expect(html).toMatch(/<option value="fr" lang="fr" selected="">/);
  });

  const day = (d: number) => `2026-10-0${d}`;
  const series = [1, 2, 3].map((d) => ({ day: day(d), value: d * 2 }));
  const data: AdminMetrics = {
    from: day(1), to: day(3), lastRolledDay: day(3), generatedAt: '2026-10-04T00:00:00.000Z',
    northStar: { key: 'qualified_talent_discoveries', name: 'Qualified Talent Discoveries', definition: 'A distinct pair…', total: 12, series },
    dau: series, wau: series, uploads: series, publishes: series, scoutSearches: series, contactRequests: series,
    funnels: [{ key: 'scout_discovery', steps: [{ event: 'scout_search', users: 10 }, { event: 'shortlist_add', users: 4 }, { event: 'contact_requested', users: 0 }] }],
  };

  it('every chart has a text summary and a data table', () => {
    const html = render(<BarChart label="Daily active users" points={series} />);
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Daily active users, [^"]+: 12 in total, highest 6"/);
    expect(html).toContain('<caption class="sr-only">Daily active users</caption>');
    expect(html).toContain('<th scope="col">Day</th>');
    expect((html.match(/<th scope="row">/g) ?? []).length).toBe(3);
  });

  it('the metrics report labels its sections, charts and funnels', () => {
    const html = render(<MetricsReport data={data} />);
    expect((html.match(/role="img"/g) ?? []).length).toBe(7);
    expect(html).toContain('<caption>Scout discovery</caption>');
    expect(html).toContain('<th scope="row">Shortlisted a player</th><td>4</td><td>40%</td>');
    expect(html).toContain('<th scope="row">Requested contact</th><td>0</td><td>0%</td>');
    expect(html).toMatch(/aria-labelledby="m-north-star"/);
    expect(html).toContain('lang="en">A distinct pair');
  });
});
