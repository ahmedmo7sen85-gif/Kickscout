/**
 * Age rules. Date of birth is converted to an age band as early as possible so the rest of
 * the system reasons about bands, not birthdays.
 *
 * Legal note: digital-consent ages differ by country. Until a country's rule has been reviewed
 * by counsel, the conservative default applies: every user under 18 needs guardian consent.
 */

export const MINIMUM_ACCOUNT_AGE = 13;
export const DEFAULT_GUARDIAN_CONSENT_AGE = 18;

export type AgeBand = 'u13' | 'u16' | 'u18' | 'adult';

export interface CountryAgeRule {
  /** Users younger than this need verified guardian consent. */
  guardianConsentAge: number;
  /** Set to true only after legal review of this country's rule. */
  legallyReviewed: boolean;
  source?: string;
}

/**
 * Country overrides. Intentionally empty: entries are added only with a reviewed legal source.
 * Keyed by ISO 3166-1 alpha-2 code.
 */
export const COUNTRY_AGE_RULES: Readonly<Record<string, CountryAgeRule>> = Object.freeze({});

export function ruleFor(countryCode: string): CountryAgeRule {
  return (
    COUNTRY_AGE_RULES[countryCode.toUpperCase()] ?? {
      guardianConsentAge: DEFAULT_GUARDIAN_CONSENT_AGE,
      legallyReviewed: false,
    }
  );
}

/** Whole years between an ISO date of birth (YYYY-MM-DD) and `today`, using UTC calendar dates. */
export function ageInYears(dob: string, today: Date): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!match) throw new RangeError('dob must be YYYY-MM-DD');
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const birth = new Date(Date.UTC(y, m - 1, d));
  if (birth.getUTCFullYear() !== y || birth.getUTCMonth() !== m - 1 || birth.getUTCDate() !== d) {
    throw new RangeError('dob is not a real calendar date');
  }
  if (birth.getTime() > today.getTime()) throw new RangeError('dob is in the future');
  let age = today.getUTCFullYear() - y;
  const beforeBirthday =
    today.getUTCMonth() < m - 1 || (today.getUTCMonth() === m - 1 && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

export function ageBand(age: number): AgeBand {
  if (age < 13) return 'u13';
  if (age < 16) return 'u16';
  if (age < 18) return 'u18';
  return 'adult';
}

export function isMinor(band: AgeBand): boolean {
  return band !== 'adult';
}

export type AgeAssessment =
  | { eligible: false; reason: 'UNDER_MINIMUM_AGE' }
  | { eligible: true; band: AgeBand; guardianRequired: boolean; ruleReviewed: boolean };

export function assessAge(dob: string, countryCode: string, today: Date): AgeAssessment {
  const age = ageInYears(dob, today);
  if (age < MINIMUM_ACCOUNT_AGE) return { eligible: false, reason: 'UNDER_MINIMUM_AGE' };
  const rule = ruleFor(countryCode);
  return {
    eligible: true,
    band: ageBand(age),
    guardianRequired: age < rule.guardianConsentAge,
    ruleReviewed: rule.legallyReviewed,
  };
}
