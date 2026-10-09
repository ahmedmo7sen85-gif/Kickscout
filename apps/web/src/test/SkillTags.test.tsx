import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToastProvider } from '@/components/ui/Toast';
import { SkillTags } from '@/components/video/SkillTags';
import { createI18nValue, I18nContext } from '@/lib/i18n/provider';
import type { Locale, VideoTag } from '@/lib/types';

const tags: VideoTag[] = [
  { skill: 'elastico', name: { en: 'Elastico', ar: 'الإلاستيكو' }, source: 'ai', confidence: 0.82, model: null },
  { skill: 'dribbling', name: { en: 'Dribbling', ar: 'المراوغة' }, source: 'user', confidence: null, model: null },
];

function render(locale: Locale, editable = false) {
  const html = renderToStaticMarkup(
    <I18nContext.Provider value={createI18nValue(locale)}>
      <ToastProvider>
        <SkillTags tags={tags} editable={editable} videoId="v1" />
      </ToastProvider>
    </I18nContext.Provider>,
  );
  const doc = new DOMParserLite(html);
  return { html, doc };
}

/** Tiny attribute extractor so the test needs no DOM implementation. */
class DOMParserLite {
  constructor(private html: string) {}
  tagsWith(attr: string, value: string): string[] {
    const re = new RegExp(`<span[^>]*${attr}="${value}"[^>]*>([\\s\\S]*?)</span>(?=\\s*(?:<button|</li>|$))`, 'g');
    return [...this.html.matchAll(re)].map((m) => m[0]);
  }
}

describe('SkillTags', () => {
  it('marks AI tags as AI-suggested with their confidence, and player tags without', () => {
    const { html, doc } = render('en');
    const ai = doc.tagsWith('data-source', 'ai');
    const user = doc.tagsWith('data-source', 'user');
    expect(ai).toHaveLength(1);
    expect(user).toHaveLength(1);

    expect(ai[0]).toContain('AI-suggested tag: Elastico, 82% confidence');
    expect(ai[0]).toContain('class="tag__ai"');
    expect(ai[0]).toContain('82%');
    expect(ai[0]).toContain('tag--ai');

    expect(user[0]).toContain('Tag added by the player: Dribbling');
    expect(user[0]).not.toContain('tag__ai');
    expect(user[0]).not.toContain('%');
    expect(user[0]).toContain('tag--player');

    // The explanation that AI tags are suggestions, not ratings.
    expect(html).toContain('not how good it is');
    // Never a score or rating.
    expect(html.toLowerCase()).not.toMatch(/potential|rating|score/);
  });

  it('lets the owner reject AI tags and add their own', () => {
    const { html } = render('en', true);
    expect(html).toContain('Remove AI tag Elastico');
    expect(html).toContain('Save tag changes');
    expect(html).toContain('Skill to add');
  });

  it('labels AI tags in Arabic too', () => {
    const { html } = render('ar');
    expect(html).toContain('وسم مقترح بالذكاء الاصطناعي: الإلاستيكو، ثقة 82%');
    expect(html).toContain('وسم أضافه اللاعب: المراوغة');
  });
});
