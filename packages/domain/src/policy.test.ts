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
  consents: new Set<ConsentPurpose>(['account', 'scout_contact']),
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

  it('lets staff and assigned judges judge challenge entries, never their own or their child’s', () => {
    const j = (over: Partial<Actor>, a: Partial<{ assigned: boolean; ownerId: string; clipPublic: boolean }> = {}) =>
      can(actor(over), { kind: 'challenge.judge', assigned: false, ownerId: 'p', clipPublic: true, ...a });
    expect(j({ roles: ['moderator'], mfa: true }).allowed).toBe(true);
    expect(j({ roles: ['moderator'] })).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(j({ roles: ['fan'], mfa: true })).toMatchObject({ code: 'FORBIDDEN' });
    expect(j({ roles: ['scout'], mfa: true }, { assigned: true }).allowed).toBe(true);
    expect(j({ roles: ['scout'], mfa: true }, { assigned: true, clipPublic: false })).toMatchObject({ code: 'FORBIDDEN' });
    expect(j({ roles: ['admin'], mfa: true }, { ownerId: 'a' })).toMatchObject({ code: 'CONFLICT_OF_INTEREST' });
    expect(j({ roles: ['admin'], mfa: true, guardianOf: ['p'] })).toMatchObject({ code: 'CONFLICT_OF_INTEREST' });
  });

  it('lets only verified scouts record a Scout Pick', () => {
    expect(can(actor({ roles: ['fan', 'scout'] }), { kind: 'challenge.scout_pick' }).allowed).toBe(true);
    expect(can(actor({ roles: ['player'] }), { kind: 'challenge.scout_pick' })).toMatchObject({ code: 'SCOUT_VERIFICATION_REQUIRED' });
  });

  it('lets only verified scouts use scout tools', () => {
    expect(can(actor({ roles: ['fan'] }), { kind: 'scout.use' })).toMatchObject({ code: 'SCOUT_VERIFICATION_REQUIRED' });
    expect(can(actor({ roles: ['scout'] }), { kind: 'scout.use' }).allowed).toBe(true);
  });

  it('lets adults found organizations, and acts inside one by membership role', () => {
    expect(can(actor({ roles: ['fan'] }), { kind: 'org.create' }).allowed).toBe(true);
    expect(can(actor({ ageBand: 'u16' }), { kind: 'org.create' })).toMatchObject({ code: 'ADULTS_ONLY' });
    const fan = actor({ roles: ['fan'] });
    const scout = actor({ roles: ['fan', 'scout'] });
    expect(can(scout, { kind: 'org.act', role: null, action: 'org.read' })).toMatchObject({ code: 'NOT_A_MEMBER' });
    expect(can(fan, { kind: 'org.act', role: 'viewer', action: 'org.read' }).allowed).toBe(true);
    expect(can(fan, { kind: 'org.act', role: 'viewer', action: 'crm.note' })).toMatchObject({ code: 'ORG_ROLE_REQUIRED' });
    expect(can(fan, { kind: 'org.act', role: 'analyst', action: 'crm.note' }).allowed).toBe(true);
    // Working with players needs the platform's scout verification as well as the organization role.
    expect(can(fan, { kind: 'org.act', role: 'owner', action: 'crm.write' })).toMatchObject({ code: 'SCOUT_VERIFICATION_REQUIRED' });
    expect(can(scout, { kind: 'org.act', role: 'scout', action: 'crm.write' }).allowed).toBe(true);
    expect(can(scout, { kind: 'org.act', role: 'scout', action: 'members.manage' })).toMatchObject({ code: 'ORG_ROLE_REQUIRED' });
    expect(can(fan, { kind: 'org.act', role: 'admin', action: 'members.manage' }).allowed).toBe(true);
    expect(can(actor({ roles: ['scout'], status: 'suspended' }), { kind: 'org.act', role: 'owner', action: 'org.read' })).toMatchObject({ code: 'ACCOUNT_INACTIVE' });
  });

  it('lets scouts request contact only when the player (or guardian) allows it', () => {
    const scout = actor({ userId: 's', roles: ['scout'] });
    expect(can(scout, { kind: 'scout.contact', playerId: 'p', playerAcceptsContact: false })).toMatchObject({ code: 'CONTACT_NOT_ALLOWED' });
    expect(can(scout, { kind: 'scout.contact', playerId: 'p', playerAcceptsContact: true }).allowed).toBe(true);
    expect(can(actor({ roles: ['fan'] }), { kind: 'scout.contact', playerId: 'p', playerAcceptsContact: true }).allowed).toBe(false);
  });

  it('only lets the owner or guardian edit a video and its tags', () => {
    expect(can(actor(), { kind: 'video.edit', ownerId: 'b' }).allowed).toBe(false);
    expect(can(actor({ guardianOf: ['b'] }), { kind: 'video.edit', ownerId: 'b' }).allowed).toBe(true);
  });

  it('requires admin and MFA to decide verifications', () => {
    expect(can(actor({ roles: ['moderator'], mfa: true }), { kind: 'verification.decide' }).allowed).toBe(false);
    expect(can(actor({ roles: ['admin'] }), { kind: 'verification.decide' })).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(can(actor({ roles: ['admin'], mfa: true }), { kind: 'verification.decide' }).allowed).toBe(true);
  });

  it('makes a guardian grant a minor’s consents', () => {
    expect(can(actor({ ageBand: 'u16' }), { kind: 'consent.grant', subjectId: 'a', purpose: 'scout_contact' })).toMatchObject({ code: 'GUARDIAN_REQUIRED' });
    expect(can(actor({ userId: 'g', guardianOf: ['a'] }), { kind: 'consent.grant', subjectId: 'a', purpose: 'scout_contact' }).allowed).toBe(true);
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

  it('lets a minor tighten privacy but only the guardian loosen it, and only after public-profile consent', () => {
    const kid = actor({ ageBand: 'u16' });
    const change = { kind: 'privacy.update', subjectId: 'a', subjectMinor: true, publicProfileConsent: true } as const;
    expect(can(kid, { ...change, loosens: false, opensProfile: false }).allowed).toBe(true);
    expect(can(kid, { ...change, loosens: true, opensProfile: true })).toMatchObject({ code: 'GUARDIAN_REQUIRED' });
    const guardian = actor({ userId: 'g', guardianOf: ['a'] });
    expect(can(guardian, { ...change, loosens: true, opensProfile: true }).allowed).toBe(true);
    expect(can(guardian, { ...change, loosens: true, opensProfile: true, publicProfileConsent: false })).toMatchObject({ code: 'GUARDIAN_REQUIRED' });
    expect(can(actor({ userId: 'x' }), { ...change, subjectMinor: false, loosens: false, opensProfile: false })).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('routes a minor’s account deletion through a linked guardian', () => {
    const del = { kind: 'account.delete', subjectId: 'a' } as const;
    expect(can(actor(), { ...del, subjectMinor: false, subjectHasGuardian: false }).allowed).toBe(true);
    expect(can(actor({ ageBand: 'u16' }), { ...del, subjectMinor: true, subjectHasGuardian: true })).toMatchObject({ code: 'GUARDIAN_REQUIRED' });
    expect(can(actor({ userId: 'g', guardianOf: ['a'] }), { ...del, subjectMinor: true, subjectHasGuardian: true }).allowed).toBe(true);
    expect(can(actor({ userId: 'x' }), { ...del, subjectMinor: false, subjectHasGuardian: false })).toMatchObject({ code: 'FORBIDDEN' });
    // An account still waiting for guardian consent may ask to be deleted.
    expect(can(actor({ ageBand: 'u16', status: 'pending_consent' }), { ...del, subjectMinor: true, subjectHasGuardian: true })).toMatchObject({ code: 'GUARDIAN_REQUIRED' });
  });

  it('lets only the uploader, or a minor’s guardian, file a counter-notice', () => {
    expect(can(actor(), { kind: 'copyright.counter_notice', ownerId: 'a', ownerMinor: false }).allowed).toBe(true);
    expect(can(actor(), { kind: 'copyright.counter_notice', ownerId: 'b', ownerMinor: false }).allowed).toBe(false);
    expect(can(actor({ ageBand: 'u16' }), { kind: 'copyright.counter_notice', ownerId: 'a', ownerMinor: true })).toMatchObject({ code: 'GUARDIAN_REQUIRED' });
  });
});
