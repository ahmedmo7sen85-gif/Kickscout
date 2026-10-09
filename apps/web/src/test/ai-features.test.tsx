import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiUsageTable } from '@/app/admin/AdminView';
import { RecommendationControls, WhyThis } from '@/components/feed/Recommendations';
import { FilterChips, NlInterpretation } from '@/components/scout/NlSearch';
import { ToastProvider } from '@/components/ui/Toast';
import { createI18nValue, I18nContext } from '@/lib/i18n/provider';
import type { Locale, RecommendationSettingsView } from '@/lib/types';

const render = (node: ReactNode, locale: Locale = 'en') => renderToStaticMarkup(
  <I18nContext.Provider value={createI18nValue(locale)}><ToastProvider>{node}</ToastProvider></I18nContext.Provider>,
);
const noop = () => {};

describe('natural-language scout search', () => {
  const filters = { position: 'LW' as const, foot: 'left' as const, ageGroup: 'u16' as const, country: 'EG', skill: 'dribbling' as const, verifiedOnly: true, minFollowers: 100 };

  it('shows every interpreted filter as a removable chip, in English and Arabic', () => {
    const en = render(<FilterChips filters={filters} onRemove={noop} />);
    expect([...en.matchAll(/data-filter="([a-zA-Z]+)"/g)].map((m) => m[1])).toEqual(['position', 'foot', 'ageGroup', 'country', 'skill', 'verifiedOnly', 'minFollowers']);
    expect(en).toContain('aria-label="Remove filter Position: Left winger"');
    expect(en).toContain('At least 100 followers');
    const ar = render(<FilterChips filters={filters} onRemove={noop} />, 'ar');
    expect(ar).toContain('data-filter="position"');
    expect(ar).not.toContain('Remove filter');
  });

  it('says so when nothing was recognised', () => {
    expect(render(<FilterChips filters={{}} onRemove={noop} />)).toContain('data-testid="nl-no-filters"');
  });

  it('shows what was searched and which parser read the question', () => {
    const explanation = { en: 'Searching left wingers.', ar: 'البحث عن أجنحة يسرى.' };
    const ai = render(<NlInterpretation result={{ parser: 'ai', model: 'claude-haiku-5-5', explanation }} />);
    expect(ai).toContain('Searching left wingers.');
    expect(ai).toContain('claude-haiku-5-5');
    expect(ai).toContain('data-parser="ai"');
    const rules = render(<NlInterpretation result={{ parser: 'rules', model: null, explanation }} />, 'ar');
    expect(rules).toContain('البحث عن أجنحة يسرى.');
    expect(rules).toContain('data-parser="rules"');
  });
});

describe('For You controls', () => {
  const settings: RecommendationSettingsView = {
    personalize: true, available: true, historyResetAt: null, notInterested: { videos: 2, players: 1, skills: ['nutmeg'] },
  };

  it('renders the personalisation switch, the summary and the reset button', () => {
    const html = render(<RecommendationControls settings={settings} busy={false} onToggle={noop} onReset={noop} />);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('Personalize my feed');
    expect(html).toContain('2 hidden clips, 1 players and 1 skills');
    expect(html).toContain('Reset history');
    expect(html).not.toContain('not switched on yet');
  });

  it('says when personalisation is not switched on, and shows the switch off', () => {
    const html = render(<RecommendationControls settings={{ ...settings, available: false, personalize: false }} busy={false} onToggle={noop} onReset={noop} />, 'ar');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('role="note"');
  });

  it('explains why a clip is shown and offers "Not interested"', () => {
    const why = { code: 'following', text: { en: 'You follow @star', ar: 'أنت تتابع @star' } };
    const en = render(<WhyThis why={why} onNotInterested={noop} />);
    expect(en).toContain('Why am I seeing this?');
    expect(en).toContain('You follow @star');
    expect(en).toContain('data-reason="following"');
    expect(en).toContain('Not interested');
    expect(render(<WhyThis why={why} onNotInterested={noop} />, 'ar')).toContain('أنت تتابع @star');
    expect(render(<WhyThis why={why} />)).not.toContain('Not interested');
    expect(render(<WhyThis why={undefined} />)).not.toContain('feed-why');
  });
});

describe('AI usage in the admin view', () => {
  it('lists the routes and per-model usage', () => {
    const html = render(<AiUsageTable formatNumber={String} usage={{
      since: '2026-10-01T00:00:00.000Z', available: false,
      routes: [{ task: 'nl_scout_query', tier: 'light', model: 'claude-haiku-5-5', effort: 'low', maxTokens: 2048, timeoutMs: 10000 }],
      items: [{ task: 'video_analysis', model: 'claude-opus-5-5', calls: 3, ok: 2, failed: 1, inputTokens: 900, outputTokens: 120, avgLatencyMs: 2100 }],
    }} />);
    expect(html).toContain('nl_scout_query: claude-haiku-5-5 · light · low');
    expect(html).toContain('claude-opus-5-5');
    expect(html).toContain('No AI key configured');
  });
});
