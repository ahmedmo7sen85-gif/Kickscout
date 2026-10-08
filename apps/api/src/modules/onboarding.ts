import {
  ConsentRequest, ConsentState, GuardianAcceptRequest, GuardianInviteRequest, GuardianInviteResponse, MeView,
  RegisterRequest, RegisterResponse,
} from '@fp/contracts';
import { assessAge, isMinor } from '@fp/domain';
import type { AgeBand } from '@fp/domain';
import { route } from '../platform/route.js';
import { ApiError, conflict, forbidden, notFound } from '../platform/errors.js';
import { encrypt, newToken, sha256 } from '../platform/crypto.js';
import { newId } from '../platform/ids.js';
import { audit, emit } from '../platform/events.js';
import { ageBandOf } from '../platform/actor.js';
import { profileView } from './views.js';

const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;

export const onboardingRoutes = [
  route(
    { method: 'post', path: '/v1/onboarding/register', summary: 'Register the signed-in identity as a user', tag: 'onboarding', auth: 'identity', body: RegisterRequest, response: RegisterResponse, status: 201 },
    async ({ deps, identity, actor, body }) => {
      if (!identity) throw new ApiError(401, 'UNAUTHENTICATED', 'sign in required');
      if (actor) throw conflict('ALREADY_REGISTERED', 'this account is already registered');

      const age = assessAge(body.dob, body.countryCode, deps.now());
      // Under-age sign-ups are refused without storing the date of birth.
      if (!age.eligible) throw forbidden('UNDER_MINIMUM_AGE', 'you must be at least 13 to create an account');

      const minor = isMinor(age.band);
      const userId = newId();
      const country = await deps.db.selectFrom('regions').select('id').where('code', '=', body.countryCode).where('kind', '=', 'country').executeTakeFirst();

      await deps.db.transaction().execute(async (tx) => {
        const handleTaken = await tx.selectFrom('profiles').select('user_id').where('handle', '=', body.handle).executeTakeFirst();
        if (handleTaken) throw conflict('HANDLE_TAKEN', 'that handle is taken');

        await tx.insertInto('users').values({
          id: userId,
          idp_subject: identity.subject,
          email: identity.email,
          email_verified: identity.emailVerified,
          locale: body.locale,
          status: age.guardianRequired ? 'pending_consent' : 'active',
        }).execute();
        await tx.insertInto('age_records').values({
          user_id: userId,
          dob_encrypted: encrypt(deps.dobKey, body.dob),
          country_code: body.countryCode,
          age_band: age.band,
          guardian_required: age.guardianRequired,
        }).execute();
        await tx.insertInto('profiles').values({ user_id: userId, handle: body.handle, display_name: body.displayName, region_id: country?.id ?? null }).execute();
        await tx.insertInto('user_roles').values(body.roles.map((role) => ({ user_id: userId, role }))).execute();
        if (body.roles.includes('player')) await tx.insertInto('player_profiles').values({ user_id: userId }).execute();
        // Minors start private, followers-only comments and country-level region until a guardian decides otherwise.
        await tx.insertInto('privacy_settings').values(
          minor
            ? { user_id: userId, profile_visibility: 'private', region_precision: 'country', comments: 'followers', direct_messages: false }
            : { user_id: userId },
        ).execute();
        if (!age.guardianRequired) {
          await tx.insertInto('consents').values(
            (['account', 'public_profile'] as const).map((purpose) => ({
              id: newId(), subject_user_id: userId, granted_by: userId, purpose, granted: true, policy_version: deps.config.POLICY_VERSION,
            })),
          ).execute();
        }
        await audit(tx, { actorId: userId, action: 'user.registered', targetKind: 'user', targetId: userId, metadata: { ageBand: age.band, guardianRequired: age.guardianRequired } });
        await emit(tx, 'user.registered', { userId });
      });

      return { userId, status: age.guardianRequired ? 'pending_consent' : 'active', guardianRequired: age.guardianRequired } as const;
    },
  ),

  route(
    { method: 'get', path: '/v1/me', summary: 'The signed-in user', tag: 'onboarding', auth: 'user', response: MeView },
    async (ctx) => {
      const me = ctx.me();
      const [profile, age] = await Promise.all([
        profileView(ctx.deps, me, me.userId),
        ctx.deps.db.selectFrom('age_records').select('guardian_required').where('user_id', '=', me.userId).executeTakeFirstOrThrow(),
      ]);
      if (!profile) throw notFound('profile');
      return { userId: me.userId, status: me.status, roles: [...me.roles], ageGroup: me.ageBand, guardianRequired: age.guardian_required, profile };
    },
  ),

  route(
    { method: 'post', path: '/v1/guardians/invitations', summary: 'A minor invites a parent or guardian', tag: 'safety', auth: 'user', body: GuardianInviteRequest, response: GuardianInviteResponse, status: 201 },
    async (ctx) => {
      const me = ctx.me();
      if (!isMinor(me.ageBand)) throw forbidden('NOT_A_MINOR', 'guardian invitations are for minors');
      const token = newToken();
      const id = newId();
      const expiresAt = new Date(ctx.deps.now().getTime() + INVITATION_TTL_MS);
      const profile = await ctx.deps.db.selectFrom('profiles').innerJoin('users', 'users.id', 'profiles.user_id')
        .select(['profiles.display_name', 'users.locale']).where('profiles.user_id', '=', me.userId).executeTakeFirstOrThrow();

      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.updateTable('guardian_invitations').set({ status: 'expired' })
          .where('minor_user_id', '=', me.userId).where('status', '=', 'pending').execute();
        await tx.insertInto('guardian_invitations').values({
          id, minor_user_id: me.userId, guardian_email: ctx.body.guardianEmail, token_hash: sha256(token), expires_at: expiresAt,
        }).execute();
        await audit(tx, { actorId: me.userId, action: 'guardian.invited', targetKind: 'user', targetId: me.userId });
      });
      await ctx.deps.mailer.sendGuardianInvitation(ctx.body.guardianEmail, profile.display_name, token, profile.locale === 'ar' ? 'ar' : 'en');
      return { invitationId: id, expiresAt: expiresAt.toISOString() };
    },
  ),

  route(
    { method: 'post', path: '/v1/guardians/invitations/accept', summary: 'A guardian accepts an invitation', tag: 'safety', auth: 'user', body: GuardianAcceptRequest, status: 204 },
    async (ctx) => {
      const me = ctx.me();
      if (isMinor(me.ageBand)) throw forbidden('GUARDIAN_MUST_BE_ADULT', 'a guardian must be an adult');
      const inv = await ctx.deps.db.selectFrom('guardian_invitations').selectAll()
        .where('token_hash', '=', sha256(ctx.body.token)).executeTakeFirst();
      if (!inv || inv.status !== 'pending' || inv.expires_at.getTime() < ctx.deps.now().getTime()) {
        throw new ApiError(410, 'INVITATION_INVALID', 'this invitation is invalid or has expired');
      }
      // The invitation is bound to the email it was sent to, and that email must be verified.
      const email = ctx.identity?.email?.toLowerCase();
      if (!email || !ctx.identity?.emailVerified || email !== inv.guardian_email.toLowerCase()) {
        throw forbidden('EMAIL_MISMATCH', 'sign in with the verified email address the invitation was sent to');
      }
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.updateTable('guardian_invitations').set({ status: 'accepted' }).where('id', '=', inv.id).execute();
        await tx.insertInto('guardian_relationships').values({ guardian_user_id: me.userId, minor_user_id: inv.minor_user_id })
          .onConflict((oc) => oc.columns(['guardian_user_id', 'minor_user_id']).doUpdateSet({ status: 'active' })).execute();
        await audit(tx, { actorId: me.userId, action: 'guardian.linked', targetKind: 'user', targetId: inv.minor_user_id });
      });
    },
  ),

  route(
    { method: 'post', path: '/v1/consents', summary: 'Grant or withdraw a consent', tag: 'safety', auth: 'user', body: ConsentRequest, status: 204 },
    async (ctx) => {
      const me = ctx.me();
      const { subjectId, purpose, granted, policyVersion } = ctx.body;
      ctx.authorize({ kind: 'consent.grant', subjectId, purpose });
      const subjectBand: AgeBand | null = await ageBandOf(ctx.deps.db, subjectId);
      if (!subjectBand) throw notFound('user');
      if (purpose === 'model_training' && granted && isMinor(subjectBand) && !me.guardianOf.includes(subjectId)) {
        throw forbidden('GUARDIAN_REQUIRED', 'model training consent for a minor must come from a guardian');
      }

      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.insertInto('consents').values({ id: newId(), subject_user_id: subjectId, granted_by: me.userId, purpose, granted, policy_version: policyVersion }).execute();
        if (purpose === 'account') {
          await tx.updateTable('users').set({ status: granted ? 'active' : 'pending_consent' })
            .where('id', '=', subjectId).where('status', 'in', ['active', 'pending_consent']).execute();
        }
        if (purpose === 'public_profile') {
          await tx.updateTable('privacy_settings').set({ profile_visibility: granted ? 'public' : 'private', updated_at: ctx.deps.now() })
            .where('user_id', '=', subjectId).execute();
        }
        await audit(tx, { actorId: me.userId, action: granted ? 'consent.granted' : 'consent.withdrawn', targetKind: 'user', targetId: subjectId, metadata: { purpose, policyVersion } });
      });
    },
  ),

  route(
    { method: 'get', path: '/v1/users/:userId/consents', summary: 'Current consent state', tag: 'safety', auth: 'user', response: ConsentState },
    async (ctx) => {
      const me = ctx.me();
      const subjectId = ctx.params.userId!;
      if (subjectId !== me.userId && !me.guardianOf.includes(subjectId) && !me.roles.includes('admin')) throw forbidden('FORBIDDEN', 'not your consents');
      const rows = await ctx.deps.db.selectFrom('consents').select(['purpose', 'granted', 'policy_version', 'created_at'])
        .distinctOn('purpose').where('subject_user_id', '=', subjectId)
        .orderBy('purpose').orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
      return {
        subjectId,
        consents: rows.map((r) => ({ purpose: r.purpose as never, granted: r.granted, policyVersion: r.policy_version, at: r.created_at.toISOString() })),
      };
    },
  ),
];
