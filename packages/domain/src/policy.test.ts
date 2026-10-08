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

  it('lets only verified scouts use scout tools', () => {
    expect(can(actor({ roles: ['fan'] }), { kind: 'scout.use' })).toMatchObject({ code: 'SCOUT_VERIFICATION_REQUIRED' });
    expect(can(actor({ roles: ['scout'] }), { kind: 'scout.use' }).allowed).toBe(true);
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
});
