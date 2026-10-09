import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CopyrightTakedownRequest, CreateOrgInvitationRequest, CreateSavedSearchRequest, CrmStageChangeRequest, AddToPipelineRequest, ReportRequest,
  UpdateOrganizationRequest, VerificationRequestCreate, CreateUploadRequest, DeleteAccountRequest, Position, RegisterRequest, SkillKey, UpdateNotificationPreferencesRequest,
  CheckoutRequest, CouponValidateRequest, PlanList,
  VideoCategory, buildOpenApi, NlScoutSearchRequest, NlScoutSearchResponse, UpdateRecommendationSettingsRequest, RadarCategory, FeedPage,
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

  it('accepts only month or year billing and ISO currency codes at checkout, defaulting to USD', () => {
    expect(CheckoutRequest.parse({ planKey: 'player_pro', interval: 'year' })).toEqual({ planKey: 'player_pro', interval: 'year', currency: 'USD' });
    expect(CheckoutRequest.safeParse({ planKey: 'player_pro', interval: 'week' }).success).toBe(false);
    expect(CheckoutRequest.safeParse({ planKey: 'player_pro', interval: 'month', currency: 'usd' }).success).toBe(false);
    expect(CheckoutRequest.safeParse({ planKey: 'Player Pro', interval: 'month' }).success).toBe(false);
    expect(CouponValidateRequest.safeParse({ code: 'no spaces here', planKey: 'player_pro' }).success).toBe(false);
  });

  it('marks unlimited quotas as null in plan limits', () => {
    const plan = {
      key: 'scout_pro', audience: 'scout', tier: 'pro', name: { en: 'Scout Pro', ar: 'x' }, description: { en: 'd', ar: 'd' }, checkout: 'self_serve',
      trialDays: 14, prices: [{ currency: 'USD', interval: 'month', amountMinor: 2900 }], features: [{ key: 'FEATURE_PRO_ANALYTICS', status: 'coming_soon' }],
      limits: { maxVideoSeconds: 60, maxActiveVideos: 20, maxUploadsPerDay: 10, scoutSearchesPerMonth: null, shortlistSlots: null, seats: 1 },
    };
    expect(PlanList.safeParse({ currency: 'USD', paymentsEnabled: false, items: [plan] }).success).toBe(true);
    expect(PlanList.safeParse({ currency: 'USD', paymentsEnabled: false, items: [{ ...plan, limits: { ...plan.limits, maxVideoSeconds: null } }] }).success).toBe(false);
  });

  it('validates natural-language search and recommendation controls', () => {
    expect(NlScoutSearchRequest.parse({ query: '  left wingers  ' })).toEqual({ query: 'left wingers', limit: 20 });
    expect(NlScoutSearchRequest.safeParse({ query: '' }).success).toBe(false);
    expect(NlScoutSearchRequest.safeParse({ query: 'x'.repeat(301) }).success).toBe(false);
    const ok = { filters: { position: 'LW' }, parser: 'rules', model: null, explanation: { en: 'a', ar: 'b' }, results: { items: [], nextCursor: null } };
    expect(NlScoutSearchResponse.safeParse(ok).success).toBe(true);
    // A filter the scout search does not know is not a filter.
    expect(NlScoutSearchResponse.shape.filters.strict().safeParse({ rating: 90 }).success).toBe(false);
    expect(UpdateRecommendationSettingsRequest.safeParse({ personalize: false, track: true }).success).toBe(false);
    expect(RadarCategory.options).toEqual(['rising', 'most_watched', 'most_saved', 'new_talents', 'hidden_gems', 'most_improved', 'top_by_skill', 'new_to_platform', 'regional_standouts']);
    expect(FeedPage.parse({ tab: 'for_you', capability: { key: 'feed.for_you', status: 'live', label: null }, items: [], nextCursor: null })).toMatchObject({ personalized: false, why: {} });
  });
});
