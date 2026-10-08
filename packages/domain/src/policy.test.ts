import { describe, expect, it } from 'vitest';
import { can } from './policy.js';
import type { Actor, ConsentPurpose } from './policy.js';

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: 'a',
  roles: ['player'],
  status: 'active',
  ageBand: 'adult',
  mfa: false,
  guardianOf: [],
  consents: new Set<ConsentPurpose>(['account', 'ai_analysis']),
  ...over,
});

describe('can()', () => {
  it('blocks everything but consent while guardian consent is pending', () => {
    const a = actor({ status: 'pending_consent' });
    expect(can(a, { kind: 'video.upload' })).toMatchObject({ allowed: false, code: 'CONSENT_REQUIRED' });
    expect(can(a, { kind: 'social.engage' }).allowed).toBe(false);
  });

  it('lets only uploader roles upload', () => {
    expect(can(actor(), { kind: 'video.upload' }).allowed).toBe(true);
    expect(can(actor({ roles: ['fan'] }), { kind: 'video.upload' }).allowed).toBe(false);
  });

  it('requires AI analysis consent and ownership to request analysis', () => {
    expect(can(actor(), { kind: 'analysis.request', videoOwnerId: 'a' }).allowed).toBe(true);
    expect(can(actor(), { kind: 'analysis.request', videoOwnerId: 'b' }).allowed).toBe(false);
    expect(can(actor({ consents: new Set(['account']) }), { kind: 'analysis.request', videoOwnerId: 'a' })).toMatchObject({ code: 'CONSENT_REQUIRED' });
  });

  it("keeps a minor's analysis away from the public but open to verified scouts and guardians", () => {
    const action = { kind: 'analysis.view', subjectId: 'kid', subjectPublic: true, subjectAgeBand: 'u16' } as const;
    expect(can(actor({ roles: ['fan'] }), action).allowed).toBe(false);
    expect(can(actor({ roles: ['scout'] }), action).allowed).toBe(true);
    expect(can(actor({ roles: ['fan'], guardianOf: ['kid'] }), action).allowed).toBe(true);
  });

  it('only lets the claimed player confirm identity', () => {
    expect(can(actor(), { kind: 'selection.confirm', claimedPlayerId: 'someone-else' }).allowed).toBe(false);
    expect(can(actor(), { kind: 'selection.confirm', claimedPlayerId: 'a' }).allowed).toBe(true);
  });

  it('makes a guardian grant a minor’s consents', () => {
    expect(can(actor({ ageBand: 'u16' }), { kind: 'consent.grant', subjectId: 'a', purpose: 'ai_analysis' })).toMatchObject({ code: 'GUARDIAN_REQUIRED' });
    expect(can(actor({ userId: 'g', guardianOf: ['a'] }), { kind: 'consent.grant', subjectId: 'a', purpose: 'ai_analysis' }).allowed).toBe(true);
  });

  it('requires MFA for admin access', () => {
    expect(can(actor({ roles: ['admin'] }), { kind: 'admin.access' })).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(can(actor({ roles: ['admin'], mfa: true }), { kind: 'admin.access' }).allowed).toBe(true);
  });

  it('honours comment settings and blocks', () => {
    const c = { kind: 'comment.create', videoOwnerId: 'o', isFollower: false, blocked: false } as const;
    expect(can(actor(), { ...c, commentsSetting: 'off' }).allowed).toBe(false);
    expect(can(actor(), { ...c, commentsSetting: 'followers' }).allowed).toBe(false);
    expect(can(actor(), { ...c, commentsSetting: 'everyone', blocked: true }).allowed).toBe(false);
  });
});
