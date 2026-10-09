/**
 * Feature-flag evaluation. Pure and deterministic: the same flag and subject always land in the
 * same bucket, on every instance, with no shared state. Flags never gate anything safety-critical.
 */
import type { Role } from './policy.js';

export interface FlagAudience {
  /** On only for callers holding at least one of these roles. */
  roles?: readonly Role[];
  /** On only for callers whose sign-up country is one of these (ISO 3166-1 alpha-2). */
  countries?: readonly string[];
}

export interface FlagDefinition {
  key: string;
  enabled: boolean;
  /** 0 to 100: the share of matching subjects for whom the flag is on. */
  rolloutPercentage: number;
  audience: FlagAudience;
}

export interface FlagSubject {
  /** The signed-in user id, or a stable anonymous key; null when neither is known. */
  key: string | null;
  roles: readonly Role[];
  country: string | null;
}

/** FNV-1a 32-bit over the UTF-8 bytes. Not cryptographic; only needs to be stable and well spread. */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  const mix = (byte: number) => {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  // UTF-8 by hand: this package runs in the browser and on the server without either's globals.
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) mix(cp);
    else if (cp < 0x800) { mix(0xc0 | (cp >> 6)); mix(0x80 | (cp & 0x3f)); }
    else if (cp < 0x10000) { mix(0xe0 | (cp >> 12)); mix(0x80 | ((cp >> 6) & 0x3f)); mix(0x80 | (cp & 0x3f)); }
    else { mix(0xf0 | (cp >> 18)); mix(0x80 | ((cp >> 12) & 0x3f)); mix(0x80 | ((cp >> 6) & 0x3f)); mix(0x80 | (cp & 0x3f)); }
  }
  return h >>> 0;
}

/** The subject's bucket for this flag, 0 to 99. Salting with the key keeps rollouts of different flags independent. */
export function flagBucket(flagKey: string, subjectKey: string): number {
  return fnv1a32(`${flagKey}:${subjectKey}`) % 100;
}

export function matchesAudience(audience: FlagAudience, subject: FlagSubject): boolean {
  if (audience.roles?.length && !audience.roles.some((r) => subject.roles.includes(r))) return false;
  if (audience.countries?.length && (!subject.country || !audience.countries.includes(subject.country))) return false;
  return true;
}

/**
 * On when enabled, the audience matches, and the subject's bucket is inside the rollout. A subject
 * with no key (signed out, no anonymous id) only gets fully rolled-out flags.
 */
export function evaluateFlag(flag: FlagDefinition, subject: FlagSubject): boolean {
  if (!flag.enabled || flag.rolloutPercentage <= 0) return false;
  if (!matchesAudience(flag.audience, subject)) return false;
  if (flag.rolloutPercentage >= 100) return true;
  if (!subject.key) return false;
  return flagBucket(flag.key, subject.key) < flag.rolloutPercentage;
}
