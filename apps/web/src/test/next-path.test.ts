import { describe, expect, it } from 'vitest';
import { safeNext, withNext } from '@/lib/next-path';

describe('return path after sign-in', () => {
  it('keeps same-site paths with their query', () => {
    expect(safeNext('/guardian/accept?token=abc')).toBe('/guardian/accept?token=abc');
    expect(safeNext('/home')).toBe('/home');
  });
  it('refuses anything that could leave the site', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, undefined]) {
      expect(safeNext(bad)).toBeNull();
    }
  });
  it('appends next only when there is one', () => {
    expect(withNext('/login', null)).toBe('/login');
    expect(withNext('/login', '/guardian/accept?token=a&b=1')).toBe('/login?next=%2Fguardian%2Faccept%3Ftoken%3Da%26b%3D1');
    expect(withNext('/auth/callback?x=1', '/home')).toBe('/auth/callback?x=1&next=%2Fhome');
  });
});
