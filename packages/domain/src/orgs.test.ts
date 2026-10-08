import { describe, expect, it } from 'vitest';
import { CRM_STAGES, ORG_ROLES, canManageMember, normaliseTags, orgCan, stageMove } from './orgs.js';
import type { OrgAction, OrgRole } from './orgs.js';

describe('organization roles', () => {
  it('follows the role matrix: viewer reads, analyst notes, scout runs the CRM, admin manages members, owner owns', () => {
    const matrix: Record<OrgRole, OrgAction[]> = {
      viewer: ['org.read'],
      analyst: ['org.read', 'crm.note'],
      scout: ['org.read', 'crm.note', 'crm.write'],
      admin: ['org.read', 'crm.note', 'crm.write', 'members.manage'],
      owner: ['org.read', 'crm.note', 'crm.write', 'members.manage', 'org.owner'],
    };
    const actions: OrgAction[] = ['org.read', 'crm.note', 'crm.write', 'members.manage', 'org.owner'];
    for (const role of ORG_ROLES) {
      for (const a of actions) expect(orgCan(role, a), `${role} ${a}`).toBe(matrix[role].includes(a));
    }
    for (const a of actions) expect(orgCan(null, a)).toBe(false);
  });

  it('keeps admins away from other admins and the owner, and never grants ownership', () => {
    expect(canManageMember('admin', null, 'scout')).toBe(true);
    expect(canManageMember('admin', 'viewer', 'analyst')).toBe(true);
    expect(canManageMember('admin', null, 'admin')).toBe(false);
    expect(canManageMember('admin', 'admin', null)).toBe(false);
    expect(canManageMember('admin', 'owner', null)).toBe(false);
    expect(canManageMember('owner', 'admin', 'viewer')).toBe(true);
    expect(canManageMember('owner', null, 'admin')).toBe(true);
    expect(canManageMember('owner', 'scout', 'owner')).toBe(false);
    expect(canManageMember('owner', 'owner', 'admin')).toBe(false);
    expect(canManageMember('scout', null, 'viewer')).toBe(false);
    expect(canManageMember('owner', 'scout', 'viewer', true)).toBe(false);
  });
});

describe('pipeline stages', () => {
  it('has the eight stages in order', () => {
    expect(CRM_STAGES).toEqual(['new', 'watching', 'shortlisted', 'monitoring', 'contact_requested', 'contacted', 'evaluation', 'archived']);
  });

  it('routes contact through the contact-request flow and needs an accepted request for contacted and evaluation', () => {
    expect(stageMove('watching', 'contact_requested', false)).toEqual({ ok: true, via: 'contact_request' });
    expect(stageMove('contact_requested', 'contacted', false)).toMatchObject({ ok: false, code: 'CONTACT_NOT_ACCEPTED' });
    expect(stageMove('new', 'evaluation', false)).toMatchObject({ ok: false, code: 'CONTACT_NOT_ACCEPTED' });
    expect(stageMove('contact_requested', 'contacted', true)).toEqual({ ok: true, via: 'direct' });
    expect(stageMove('new', 'watching', false)).toEqual({ ok: true, via: 'direct' });
    expect(stageMove('archived', 'watching', false)).toEqual({ ok: true, via: 'direct' });
    expect(stageMove('new', 'new', false)).toMatchObject({ ok: false, code: 'SAME_STAGE' });
  });

  it('normalises tags', () => {
    expect(normaliseTags([' Left Foot ', 'left foot', 'U17', ''])).toEqual(['left foot', 'u17']);
    expect(normaliseTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(20);
  });
});
