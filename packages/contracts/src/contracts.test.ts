import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CopyrightTakedownRequest, CreateOrgInvitationRequest, CreateSavedSearchRequest, CrmStageChangeRequest, AddToPipelineRequest, ReportRequest,
  UpdateOrganizationRequest, VerificationRequestCreate, CreateUploadRequest, DeleteAccountRequest, Position, RegisterRequest, SkillKey, UpdateNotificationPreferencesRequest,
  VideoCategory, buildOpenApi,
} from './index.js';

describe('contracts', () => {
  it('normalises hashtags and rejects junk', () => {
    const base = { title: 'Elastico', contentType: 'video/mp4', sizeBytes: 1000, rightsConfirmed: true };
    expect(CreateUploadRequest.parse({ ...base, hashtags: ['#Skills', 'مهارات'] }).hashtags).toEqual(['skills', 'مهارات']);
    expect(CreateUploadRequest.safeParse({ ...base, hashtags: ['no spaces'] }).success).toBe(false);
  });

  it('rejects a trim that ends before it starts', () => {
    const base = { title: 'x', contentType: 'video/mp4', sizeBytes: 1000, rightsConfirmed: true };
    expect(CreateUploadRequest.safeParse({ ...base, trimStartMs: 5000, trimEndMs: 1000 }).success).toBe(false);
  });

  it('accepts only the supported video formats and sizes', () => {
    const base = { sizeBytes: 1000, title: 'Goal', rightsConfirmed: true };
    expect(CreateUploadRequest.safeParse({ ...base, contentType: 'video/mp4' }).success).toBe(true);
    expect(CreateUploadRequest.safeParse({ ...base, contentType: 'video/x-msvideo' }).success).toBe(false);
    expect(CreateUploadRequest.safeParse({ ...base, contentType: 'video/mp4', sizeBytes: 10 ** 10 }).success).toBe(false);
  });

  it('requires the uploader to confirm they own the video', () => {
    const base = { title: 'Goal', contentType: 'video/mp4', sizeBytes: 1000 };
    expect(CreateUploadRequest.safeParse(base).success).toBe(false);
    expect(CreateUploadRequest.safeParse({ ...base, rightsConfirmed: false }).success).toBe(false);
    expect(CreateUploadRequest.safeParse({ ...base, rightsConfirmed: true }).success).toBe(true);
  });

  it('covers the extended taxonomy and keeps the old video categories valid', () => {
    expect(Position.options).toEqual(expect.arrayContaining(['WB', 'FW']));
    expect(SkillKey.options).toEqual(expect.arrayContaining(['la_croqueta', 'through_ball', 'reflexes', 'match_highlight']));
    for (const c of ['match', 'training', 'freestyle', 'challenge', 'other', 'goal', 'one_v_one', 'showcase']) expect(VideoCategory.safeParse(c).success).toBe(true);
  });

  it('demands explicit statements and confirmations', () => {
    const claim = { claimantName: 'Rights Holder', email: 'legal@example.com', video: 'https://kickscout.test/v/x', description: 'This is my own match footage, filmed in 2025.' };
    expect(CopyrightTakedownRequest.safeParse({ ...claim, goodFaith: true, accurate: true }).success).toBe(true);
    expect(CopyrightTakedownRequest.safeParse({ ...claim, goodFaith: true, accurate: false }).success).toBe(false);
    expect(DeleteAccountRequest.safeParse({ confirm: 'delete' }).success).toBe(false);
    expect(DeleteAccountRequest.safeParse({ confirm: 'DELETE' }).success).toBe(true);
    expect(UpdateNotificationPreferencesRequest.safeParse({ like: false }).success).toBe(true);
    expect(UpdateNotificationPreferencesRequest.safeParse({ security: false }).success).toBe(false);
  });

  it('does not let sign-up pick privileged roles', () => {
    const r = { handle: 'abc', displayName: 'A', dob: '2000-01-01', countryCode: 'EG' };
    expect(RegisterRequest.safeParse({ ...r, roles: ['player'] }).success).toBe(true);
    expect(RegisterRequest.safeParse({ ...r, roles: ['scout'] }).success).toBe(false);
    expect(RegisterRequest.safeParse({ ...r, roles: ['admin'] }).success).toBe(false);
  });

  it('validates saved-search filters with the scout search schema', () => {
    expect(CreateSavedSearchRequest.parse({ name: 'Left wingers', filters: { position: 'LW', country: 'EG', minFollowers: 10 } }))
      .toMatchObject({ alerts: false, filters: { position: 'LW', country: 'EG', minFollowers: 10 } });
    expect(CreateSavedSearchRequest.safeParse({ name: 'x', filters: { position: 'Striker' } }).success).toBe(false);
    expect(CreateSavedSearchRequest.safeParse({ name: 'x', filters: { country: 'egypt' } }).success).toBe(false);
    expect(CreateSavedSearchRequest.safeParse({ name: 'x', filters: { ageGroup: 'u10' } }).success).toBe(false);
    // Paging is not part of a saved search.
    expect(CreateSavedSearchRequest.parse({ name: 'x', filters: { cursor: 'abc', limit: 5 } }).filters).toEqual({});
  });

  it('never lets an invitation or a profile edit grant ownership or point the logo elsewhere', () => {
    expect(CreateOrgInvitationRequest.safeParse({ email: 'a@b.co', role: 'owner' }).success).toBe(false);
    expect(CreateOrgInvitationRequest.safeParse({ email: 'a@b.co', role: 'scout' }).success).toBe(true);
    expect(UpdateOrganizationRequest.safeParse({ logoKey: '../avatars/x.png' }).success).toBe(false);
    expect(UpdateOrganizationRequest.safeParse({ logoKey: 'org-logos/0190f3c4-1111-7000-8000-000000000000/logo.png' }).success).toBe(true);
  });

  it('only places cards directly in non-contact stages, and carries verification types and organization reports', () => {
    expect(AddToPipelineRequest.safeParse({ stage: 'contact_requested' }).success).toBe(false);
    expect(AddToPipelineRequest.parse({})).toEqual({ stage: 'new', tags: [] });
    expect(CrmStageChangeRequest.safeParse({ stage: 'contact_requested', message: 'hi' }).success).toBe(false);
    for (const kind of ['identity', 'player', 'scout', 'organization']) expect(VerificationRequestCreate.safeParse({ kind, evidence: 'link to our registration' }).success).toBe(true);
    expect(ReportRequest.safeParse({ targetKind: 'organization', targetId: '0190f3c4-1111-7000-8000-000000000000', reason: 'fake_scout' }).success).toBe(true);
  });

  it('builds OpenAPI paths with path and query parameters', () => {
    const doc = buildOpenApi(
      [{ method: 'get', path: '/v1/things/:thingId', summary: 's', tag: 't', auth: true, query: z.object({ limit: z.number().optional() }), response: z.object({ id: z.string() }) }],
      { title: 'x', version: '1' },
    );
    const op = (doc.paths['/v1/things/{thingId}'] as Record<string, any>).get;
    expect(op.parameters.map((p: { name: string }) => p.name)).toEqual(['thingId', 'limit']);
    expect(op.security).toEqual([{ bearer: [] }]);
  });
});
