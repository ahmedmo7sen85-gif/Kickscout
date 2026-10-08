import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/en';
import { LEGAL_DOCS, LEGAL_STATEMENTS, legalDoc } from '@/lib/legal';

describe('legal documents', () => {
  it('publishes every required document, each opening with the draft notice', () => {
    expect(LEGAL_DOCS.map((d) => d.slug).sort()).toEqual(
      ['community-guidelines', 'copyright', 'privacy', 'safety', 'scout-terms', 'subscription-terms', 'terms'],
    );
    for (const doc of LEGAL_DOCS) {
      expect(doc.sections[0]?.id, doc.slug).toBe('draft');
      expect(doc.sections[0]?.body.join(' '), doc.slug).toContain('Draft pending legal review');
      expect(en.legal[doc.titleKey], doc.slug).toBeTruthy();
      expect(new Set(doc.sections.map((s) => s.id)).size, `${doc.slug} section ids are unique`).toBe(doc.sections.length);
    }
  });

  it('the terms carry the no-guarantee statement and the due-diligence duty', () => {
    const terms = legalDoc('terms')!.sections.flatMap((s) => s.body).join(' ');
    expect(terms).toContain(LEGAL_STATEMENTS.NO_GUARANTEE);
    expect(terms).toContain(LEGAL_STATEMENTS.DUE_DILIGENCE);
    for (const word of ['contract', 'trial', 'employment', 'selection', 'sponsorship', 'transfer', 'professional success']) {
      expect(LEGAL_STATEMENTS.NO_GUARANTEE).toContain(word);
    }
    expect(LEGAL_STATEMENTS.DUE_DILIGENCE).toMatch(/due diligence/);
    // Scout terms repeat both.
    const scout = legalDoc('scout-terms')!.sections.flatMap((s) => s.body).join(' ');
    expect(scout).toContain(LEGAL_STATEMENTS.NO_GUARANTEE);
    expect(scout).toContain(LEGAL_STATEMENTS.DUE_DILIGENCE);
  });

  it('the privacy policy has a cookie section naming what is stored', () => {
    const cookies = legalDoc('privacy')!.sections.find((s) => s.id === 'cookies');
    expect(cookies?.body.join(' ')).toContain('ks_locale');
  });

  it('unknown slugs are not found', () => {
    expect(legalDoc('nope')).toBeUndefined();
  });
});
