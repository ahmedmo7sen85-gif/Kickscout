import { describe, expect, it } from 'vitest';
import { ageBand, ageInYears, assessAge } from './age.js';

const today = new Date(Date.UTC(2026, 9, 8));

describe('age rules', () => {
  it('counts whole years using the birthday', () => {
    expect(ageInYears('2010-10-08', today)).toBe(16);
    expect(ageInYears('2010-10-09', today)).toBe(15);
  });

  it('rejects impossible dates and future dates', () => {
    expect(() => ageInYears('2010-02-30', today)).toThrow(RangeError);
    expect(() => ageInYears('2030-01-01', today)).toThrow(RangeError);
    expect(() => ageInYears('08/10/2010', today)).toThrow(RangeError);
  });

  it('maps ages to bands', () => {
    expect([12, 13, 15, 16, 17, 18].map(ageBand)).toEqual(['u13', 'u16', 'u16', 'u18', 'u18', 'adult']);
  });

  it('refuses accounts under the minimum age', () => {
    expect(assessAge('2015-01-01', 'EG', today)).toEqual({ eligible: false, reason: 'UNDER_MINIMUM_AGE' });
  });

  it('requires guardian consent for every minor until a country rule is legally reviewed', () => {
    const r = assessAge('2009-06-01', 'EG', today);
    expect(r).toMatchObject({ eligible: true, band: 'u18', guardianRequired: true, ruleReviewed: false });
    expect(assessAge('2000-01-01', 'SA', today)).toMatchObject({ band: 'adult', guardianRequired: false });
  });
});
