import { z } from 'zod';
import type { Transaction } from 'kysely';
import type { DB } from '@fp/db';
import {
  AccountExport, DeleteAccountRequest, DeleteAccountResponse, NotificationPreferencesView, PrivacySettingsView,
  UpdateNotificationPreferencesRequest, UpdatePrivacyRequest,
} from '@fp/contracts';
import { can, DEFAULT_NOTIFICATION_PREFERENCES, isMinor, loosensPrivacy } from '@fp/domain';
import type { Actor, PrivacySettings } from '@fp/domain';
import type { Database } from '@fp/db';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import { forbidden, notFound } from '../platform/errors.js';
import { audit, emit, notify } from '../platform/events.js';
import { ageBandOf, currentConsents } from '../platform/actor.js';
import { decrypt } from '../platform/crypto.js';
import { removeFromOrganizations } from './orgs.js';
import { cancelAtProvider, closeSubscriptionsForDeletion } from '../platform/billing/cancellations.js';
import { entitlementsFor } from '../platform/entitlements.js';
import type { FastifyBaseLogger } from 'fastify';
import { eraseRecommendationData, recommendationExport } from './recommendations.js';
import { erasePlayData, playExport } from './play.js';

const Uuid = z.uuid();

async function loadPrivacy(db: Database, userId: string): Promise<PrivacySettings | null> {
  const r = await db.selectFrom('privacy_settings').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (!r) return null;
  return {
    profileVisibility: r.profile_visibility as PrivacySettings['profileVisibility'],
    regionPrecision: r.region_precision as PrivacySettings['regionPrecision'],
    comments: r.comments as PrivacySettings['comments'],
    directMessages: r.direct_messages,
    allowScoutDiscovery: r.allow_scout_discovery,
    allowContactRequests: r.allow_contact_requests,
    showCountry: r.show_country,
    showRegion: r.show_region,
    showAge: r.show_age,
    allowAnalytics: r.allow_analytics,
  };
}

async function privacyView(db: Database, subjectId: string): Promise<z.input<typeof PrivacySettingsView> | null> {
  const [p, band] = await Promise.all([loadPrivacy(db, subjectId), ageBandOf(db, subjectId)]);
  if (!p) return null;
  const { directMessages: _dm, ...rest } = p;
  return { subjectId, ...rest, minorProtections: !band || isMinor(band) };
}

/** Self, a guardian or an admin may read and change privacy settings; everyone else sees nothing. */
async function privacySubject(deps: Deps, me: Actor, raw: string | undefined) {
  const parsed = Uuid.safeParse(raw);
  if (!parsed.success) throw notFound('user');
  const id = parsed.data;
  if (id !== me.userId && !me.guardianOf.includes(id) && !me.roles.includes('admin')) throw notFound('user');
  const exists = await deps.db.selectFrom('users').select('id').where('id', '=', id).where('status', '!=', 'deleted').executeTakeFirst();
  if (!exists) throw notFound('user');
  return id;
}

const PREF_COLUMNS = {
  follower: 'follower', like: 'like', comment: 'comment', saveMilestone: 'save_milestone', challenge: 'challenge',
  scoutContact: 'scout_contact', shortlistActivity: 'shortlist_activity', verification: 'verification', announcements: 'announcements',
} as const;
type PrefKey = keyof typeof PREF_COLUMNS;

async function notificationPrefs(db: Database, userId: string): Promise<z.input<typeof NotificationPreferencesView>> {
  const row = await db.selectFrom('notification_preferences').selectAll().where('user_id', '=', userId).executeTakeFirst();
  const source = row ?? DEFAULT_NOTIFICATION_PREFERENCES;
  const out = Object.fromEntries(Object.entries(PREF_COLUMNS).map(([k, col]) => [k, source[col]])) as Record<PrefKey, boolean>;
  return { ...out, security: true };
}

/**
 * Removes an account from every public surface and from other people's lists. The user row stays
 * (status 'deleted', personal fields cleared) so the handle stays reserved and the audit trail
 * holds; videos are marked deleted and their objects are purged from the `video.deleted` events.
 */
async function deleteAccount(tx: Transaction<DB>, subjectId: string, actorId: string, now: Date) {
  const videos = await tx.updateTable('videos').set({ status: 'deleted', deleted_at: now })
    .where('owner_user_id', '=', subjectId).where('status', '!=', 'deleted').returning(['id', 'original_key']).execute();
  for (const v of videos) await emit(tx, 'video.deleted', { videoId: v.id, key: v.original_key });
  await tx.updateTable('users').set({ status: 'deleted', deleted_at: now, email: null }).where('id', '=', subjectId).execute();
  await tx.updateTable('profiles').set({ display_name: 'Deleted account', bio: null, avatar_key: null, region_id: null, verified_at: null, updated_at: now })
    .where('user_id', '=', subjectId).execute();
  await tx.updateTable('privacy_settings').set({ profile_visibility: 'private', allow_scout_discovery: false, allow_contact_requests: false, updated_at: now })
    .where('user_id', '=', subjectId).execute();
  // Follows, likes and saves stop counting anywhere; scouts lose them from shortlists and notes.
  await tx.deleteFrom('follows').where((eb) => eb.or([eb('follower_id', '=', subjectId), eb('followee_id', '=', subjectId)])).execute();
  await tx.deleteFrom('likes').where('user_id', '=', subjectId).execute();
  await tx.deleteFrom('saves').where('user_id', '=', subjectId).execute();
  await tx.deleteFrom('shortlist_players').where('player_id', '=', subjectId).execute();
  await tx.deleteFrom('scout_notes').where((eb) => eb.or([eb('player_id', '=', subjectId), eb('scout_id', '=', subjectId)])).execute();
  await tx.deleteFrom('shortlists').where('owner_id', '=', subjectId).execute();
  // Organizations and pipelines: leave every organization (ownership passes on), and drop the person's
  // own pipeline, saved searches and every pipeline card about them.
  await removeFromOrganizations(tx, subjectId, now);
  await eraseRecommendationData(tx, subjectId);
  await erasePlayData(tx, subjectId);
  await tx.updateTable('contact_requests').set({ status: 'declined', responded_at: now })
    .where((eb) => eb.or([eb('scout_id', '=', subjectId), eb('player_id', '=', subjectId)])).where('status', '=', 'pending').execute();
  await tx.updateTable('guardian_relationships').set({ status: 'revoked' })
    .where((eb) => eb.or([eb('guardian_user_id', '=', subjectId), eb('minor_user_id', '=', subjectId)])).execute();
  await tx.updateTable('guardian_invitations').set({ status: 'expired' }).where('minor_user_id', '=', subjectId).where('status', '=', 'pending').execute();
  // Raw analytics about the person go with the account; only anonymous daily totals remain.
  await tx.deleteFrom('analytics_events').where('user_id', '=', subjectId).execute();
  await tx.deleteFrom('qualified_discoveries').where((eb) => eb.or([eb('player_id', '=', subjectId), eb('discoverer_id', '=', subjectId)])).execute();
  await audit(tx, { actorId, action: 'account.deleted', targetKind: 'user', targetId: subjectId, metadata: { by: actorId === subjectId ? 'self' : 'guardian', videos: videos.length } });
  await emit(tx, 'user.deleted', { userId: subjectId });
}

/** A minor with a linked guardian asked to delete: hide everything now, and ask the guardian to confirm. */
async function requestGuardianDeletion(tx: Transaction<DB>, subjectId: string, now: Date) {
  await tx.updateTable('users').set({ deletion_requested_at: now }).where('id', '=', subjectId).execute();
  await tx.updateTable('privacy_settings').set({ profile_visibility: 'private', allow_scout_discovery: false, allow_contact_requests: false, updated_at: now })
    .where('user_id', '=', subjectId).execute();
  const guardians = await tx.selectFrom('guardian_relationships').select('guardian_user_id').where('minor_user_id', '=', subjectId).where('status', '=', 'active').execute();
  for (const g of guardians) await notify(tx, g.guardian_user_id, 'account.deletion_requested', { userId: subjectId });
  await audit(tx, { actorId: subjectId, action: 'account.deletion_requested', targetKind: 'user', targetId: subjectId });
}

async function deleteRoute(deps: Deps, me: Actor, subjectId: string, log: FastifyBaseLogger): Promise<z.input<typeof DeleteAccountResponse>> {
  const subject = await deps.db.selectFrom('users').innerJoin('age_records', 'age_records.user_id', 'users.id')
    .select(['users.id', 'age_records.age_band']).where('users.id', '=', subjectId).where('users.status', '!=', 'deleted').executeTakeFirst();
  if (!subject) throw notFound('user');
  const guardian = await deps.db.selectFrom('guardian_relationships').select('guardian_user_id')
    .where('minor_user_id', '=', subjectId).where('status', '=', 'active').executeTakeFirst();
  const decision = can(me, { kind: 'account.delete', subjectId, subjectMinor: isMinor(subject.age_band as never), subjectHasGuardian: Boolean(guardian) });
  const now = deps.now();
  if (!decision.allowed) {
    if (decision.code === 'GUARDIAN_REQUIRED' && me.userId === subjectId) {
      await deps.db.transaction().execute((tx) => requestGuardianDeletion(tx, subjectId, now));
      return { status: 'pending_guardian' };
    }
    throw forbidden(decision.code, decision.reason);
  }
  // Paid plans end with the account: closed here in the same transaction, then stopped at the provider.
  // A provider failure never blocks the deletion; the row keeps the error and the billing cron retries it.
  const closed = await deps.db.transaction().execute(async (tx) => {
    await deleteAccount(tx, subjectId, me.userId, now);
    return closeSubscriptionsForDeletion(tx, subjectId, me.userId, now);
  });
  await cancelAtProvider(deps, log, closed);
  return { status: 'deleted' };
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export const accountRoutes = [
  route(
    { method: 'get', path: '/v1/users/:userId/privacy', summary: 'Privacy and discovery settings (self, guardian or admin)', tag: 'privacy', auth: 'user', response: PrivacySettingsView },
    async (ctx) => {
      const subjectId = await privacySubject(ctx.deps, ctx.me(), ctx.params.userId);
      const view = await privacyView(ctx.deps.db, subjectId);
      if (!view) throw notFound('user');
      return view;
    },
  ),
  route(
    { method: 'patch', path: '/v1/users/:userId/privacy', summary: 'Change privacy and discovery settings; for a minor only the guardian can loosen them', tag: 'privacy', auth: 'user', body: UpdatePrivacyRequest, response: PrivacySettingsView },
    async (ctx) => {
      const me = ctx.me();
      const subjectId = await privacySubject(ctx.deps, me, ctx.params.userId);
      const current = await loadPrivacy(ctx.deps.db, subjectId);
      if (!current) throw notFound('user');
      const changes = Object.fromEntries(Object.entries(ctx.body).filter(([, v]) => v !== undefined)) as Partial<PrivacySettings>;
      const next: PrivacySettings = { ...current, ...changes };
      const band = await ageBandOf(ctx.deps.db, subjectId);
      const minor = !band || isMinor(band);
      const publicProfileConsent = minor ? (await currentConsents(ctx.deps.db, subjectId)).has('public_profile') : true;
      ctx.authorize({ kind: 'privacy.update', subjectId, subjectMinor: minor, loosens: loosensPrivacy(current, next), opensProfile: next.profileVisibility !== 'private', publicProfileConsent });
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.updateTable('privacy_settings').set({
          profile_visibility: next.profileVisibility, region_precision: next.regionPrecision, comments: next.comments,
          allow_scout_discovery: next.allowScoutDiscovery, allow_contact_requests: next.allowContactRequests,
          show_country: next.showCountry, show_region: next.showRegion, show_age: next.showAge, allow_analytics: next.allowAnalytics, updated_at: ctx.deps.now(),
        }).where('user_id', '=', subjectId).execute();
        await audit(tx, { actorId: me.userId, action: 'privacy.updated', targetKind: 'user', targetId: subjectId, metadata: { changes } });
      });
      return (await privacyView(ctx.deps.db, subjectId))!;
    },
  ),

  route(
    { method: 'get', path: '/v1/me/notification-preferences', summary: 'Which in-app notifications I receive', tag: 'notifications', auth: 'user', response: NotificationPreferencesView },
    async (ctx) => notificationPrefs(ctx.deps.db, ctx.me().userId),
  ),
  route(
    { method: 'patch', path: '/v1/me/notification-preferences', summary: 'Turn notification kinds on or off (security alerts always stay on)', tag: 'notifications', auth: 'user', body: UpdateNotificationPreferencesRequest, response: NotificationPreferencesView },
    async (ctx) => {
      const me = ctx.me();
      const current = await notificationPrefs(ctx.deps.db, me.userId);
      const merged = { ...current, ...Object.fromEntries(Object.entries(ctx.body).filter(([, v]) => v !== undefined)) } as Record<PrefKey, boolean>;
      const values = Object.fromEntries(Object.entries(PREF_COLUMNS).map(([k, col]) => [col, merged[k as PrefKey]])) as Record<(typeof PREF_COLUMNS)[PrefKey], boolean>;
      await ctx.deps.db.insertInto('notification_preferences').values({ user_id: me.userId, ...values, updated_at: ctx.deps.now() })
        .onConflict((oc) => oc.column('user_id').doUpdateSet({ ...values, updated_at: ctx.deps.now() })).execute();
      return notificationPrefs(ctx.deps.db, me.userId);
    },
  ),

  route(
    { method: 'get', path: '/v1/me/export', summary: 'Download a copy of my data (JSON)', tag: 'account', auth: 'user', response: AccountExport, rateLimit: { max: 5, timeWindow: '1 hour' } },
    async (ctx) => {
      const me = ctx.me();
      const db = ctx.deps.db;
      const uid = me.userId;
      const [user, age, profile, player, region, roles, privacy, prefs, consents, videos, hashtags, comments, following, followers, likes, saves, notifications] = await Promise.all([
        db.selectFrom('users').selectAll().where('id', '=', uid).executeTakeFirstOrThrow(),
        db.selectFrom('age_records').selectAll().where('user_id', '=', uid).executeTakeFirst(),
        db.selectFrom('profiles').selectAll().where('user_id', '=', uid).executeTakeFirst(),
        db.selectFrom('player_profiles').selectAll().where('user_id', '=', uid).executeTakeFirst(),
        db.selectFrom('profiles').innerJoin('regions', 'regions.id', 'profiles.region_id').select('regions.code').where('profiles.user_id', '=', uid).executeTakeFirst(),
        db.selectFrom('user_roles').select('role').where('user_id', '=', uid).execute(),
        privacyView(db, uid),
        notificationPrefs(db, uid),
        db.selectFrom('consents').selectAll().where('subject_user_id', '=', uid).orderBy('created_at').execute(),
        db.selectFrom('videos').selectAll().where('owner_user_id', '=', uid).orderBy('created_at').execute(),
        db.selectFrom('video_hashtags').innerJoin('videos', 'videos.id', 'video_hashtags.video_id').select(['video_hashtags.video_id', 'video_hashtags.tag'])
          .where('videos.owner_user_id', '=', uid).execute(),
        db.selectFrom('comments').selectAll().where('author_id', '=', uid).orderBy('created_at').execute(),
        db.selectFrom('follows').innerJoin('profiles', 'profiles.user_id', 'follows.followee_id')
          .select(['follows.followee_id', 'follows.created_at', 'profiles.handle']).where('follows.follower_id', '=', uid).execute(),
        // Who follows you is other people's activity: the count is yours, the list is not exported.
        db.selectFrom('follows').select(db.fn.countAll<string>().as('n')).where('followee_id', '=', uid).executeTakeFirstOrThrow(),
        db.selectFrom('likes').select(['video_id', 'created_at']).where('user_id', '=', uid).execute(),
        db.selectFrom('saves').select(['video_id', 'created_at']).where('user_id', '=', uid).execute(),
        db.selectFrom('notifications').selectAll().where('user_id', '=', uid).orderBy('created_at').execute(),
      ]);
      // Billing: what you hold or pay for, with dates. Provider ids and payment details stay out.
      const [entitlements, subscriptions, redemptions] = await Promise.all([
        entitlementsFor(ctx.deps, uid, me.roles),
        db.selectFrom('subscriptions').innerJoin('plans', 'plans.key', 'subscriptions.plan_key')
          .select(['subscriptions.plan_key', 'plans.names', 'subscriptions.user_id', 'subscriptions.payer_user_id', 'subscriptions.status',
            'subscriptions.billing_interval', 'subscriptions.currency', 'subscriptions.amount_minor', 'subscriptions.trial_end',
            'subscriptions.current_period_end', 'subscriptions.cancel_at_period_end', 'subscriptions.canceled_at', 'subscriptions.created_at'])
          .where((eb) => eb.or([eb('subscriptions.user_id', '=', uid), eb('subscriptions.payer_user_id', '=', uid)]))
          .orderBy('subscriptions.created_at').execute(),
        db.selectFrom('coupon_redemptions').select(['code', 'created_at']).where('user_id', '=', uid).orderBy('created_at').execute(),
      ]);
      const isScout = me.roles.includes('scout');
      const [shortlists, members, notes] = isScout
        ? await Promise.all([
          db.selectFrom('shortlists').selectAll().where('owner_id', '=', uid).execute(),
          db.selectFrom('shortlist_players').innerJoin('shortlists', 'shortlists.id', 'shortlist_players.shortlist_id')
            .select(['shortlist_players.shortlist_id', 'shortlist_players.player_id']).where('shortlists.owner_id', '=', uid).execute(),
          db.selectFrom('scout_notes').selectAll().where('scout_id', '=', uid).execute(),
        ])
        : [[], [], []];
      let dateOfBirth: string | null = null;
      try { dateOfBirth = age ? decrypt(ctx.deps.dobKey, age.dob_encrypted) : null; } catch { dateOfBirth = null; }

      await db.transaction().execute((tx) => audit(tx, { actorId: uid, action: 'account.exported', targetKind: 'user', targetId: uid }));
      return {
        exportedAt: ctx.deps.now().toISOString(),
        account: {
          userId: uid, email: user.email, status: user.status, locale: user.locale, roles: roles.map((r) => r.role), createdAt: user.created_at.toISOString(),
          ageGroup: (age?.age_band as never) ?? null, countryCode: age?.country_code ?? null, dateOfBirth,
        },
        profile: profile ? {
          handle: profile.handle, displayName: profile.display_name, bio: profile.bio, regionCode: region?.code ?? null, verified: profile.verified_at !== null,
          player: player ? { primaryPosition: player.primary_position as never, secondaryPositions: player.secondary_positions as never, preferredFoot: player.preferred_foot as never } : null,
        } : null,
        settings: { privacy, notifications: prefs },
        consents: consents.map((c) => ({
          purpose: c.purpose as never, granted: c.granted, grantedBy: c.granted_by === uid ? 'self' as const : 'guardian' as const, policyVersion: c.policy_version, at: c.created_at.toISOString(),
        })),
        videos: videos.map((v) => ({
          id: v.id, title: v.title, description: v.description, status: v.status, visibility: v.visibility, context: v.context, skill: v.skill_key,
          position: v.position, foot: v.foot, hashtags: hashtags.filter((h) => h.video_id === v.id).map((h) => h.tag),
          rightsConfirmedAt: iso(v.rights_confirmed_at), createdAt: v.created_at.toISOString(), publishedAt: iso(v.published_at),
        })),
        comments: comments.map((c) => ({ id: c.id, videoId: c.video_id, body: c.body, status: c.moderation, createdAt: c.created_at.toISOString() })),
        following: following.map((f) => ({ userId: f.followee_id, handle: f.handle, since: f.created_at.toISOString() })),
        followers: { count: Number(followers.n) },
        likes: likes.map((l) => ({ videoId: l.video_id, at: l.created_at.toISOString() })),
        saves: saves.map((s) => ({ videoId: s.video_id, at: s.created_at.toISOString() })),
        notifications: notifications.map((n) => ({ id: n.id, kind: n.kind, payload: n.payload as Record<string, unknown>, read: n.read_at !== null, createdAt: n.created_at.toISOString() })),
        billing: {
          plans: entitlements.plans,
          subscriptions: subscriptions.map((s) => ({
            planKey: s.plan_key, planName: s.names as { en: string; ar: string }, status: s.status,
            role: s.user_id === uid ? (s.payer_user_id && s.payer_user_id !== uid ? 'beneficiary' as const : 'subscriber' as const) : 'payer' as const,
            interval: s.billing_interval, currency: s.currency, amountMinor: s.amount_minor, trialEnd: iso(s.trial_end),
            currentPeriodEnd: iso(s.current_period_end), cancelAtPeriodEnd: s.cancel_at_period_end, canceledAt: iso(s.canceled_at), createdAt: s.created_at.toISOString(),
          })),
          couponRedemptions: redemptions.map((r) => ({ code: r.code, at: r.created_at.toISOString() })),
        },
        recommendations: await recommendationExport(ctx.deps, uid),
        play: await playExport(ctx.deps.db, uid),
        scout: isScout ? {
          shortlists: shortlists.map((s) => ({ id: s.id, name: s.name, playerIds: members.filter((m) => m.shortlist_id === s.id).map((m) => m.player_id), createdAt: s.created_at.toISOString() })),
          notes: notes.map((n) => ({ id: n.id, playerId: n.player_id, body: n.body, createdAt: n.created_at.toISOString() })),
        } : null,
      };
    },
  ),

  route(
    { method: 'delete', path: '/v1/me', summary: 'Delete my account (a minor’s request waits for their guardian)', tag: 'account', auth: 'user', body: DeleteAccountRequest, response: DeleteAccountResponse, rateLimit: { max: 5, timeWindow: '1 hour' } },
    async (ctx) => deleteRoute(ctx.deps, ctx.me(), ctx.me().userId, ctx.req.log),
  ),
  route(
    { method: 'delete', path: '/v1/users/:userId/account', summary: 'A guardian deletes their ward’s account', tag: 'account', auth: 'user', body: DeleteAccountRequest, response: DeleteAccountResponse, rateLimit: { max: 5, timeWindow: '1 hour' } },
    async (ctx) => {
      const parsed = Uuid.safeParse(ctx.params.userId);
      if (!parsed.success) throw notFound('user');
      return deleteRoute(ctx.deps, ctx.me(), parsed.data, ctx.req.log);
    },
  ),
];
