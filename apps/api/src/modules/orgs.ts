import { z } from 'zod';
import type { Selectable, Transaction } from 'kysely';
import type { DB } from '@fp/db';
import {
  AcceptOrgInvitationResponse, CreateOrganizationRequest, CreateOrgInvitationRequest, CreateOrgInvitationResponse, DeleteOrganizationRequest,
  MyOrganizations, OrganizationDashboard, OrganizationInvitationView, OrganizationPublicView, OrgInvitationTokenRequest, TransferOwnershipRequest,
  UpdateOrganizationRequest, UpdateOrgMemberRequest,
} from '@fp/contracts';
import { canManageMember, isMinor } from '@fp/domain';
import type { Actor, OrgAction, OrgRole, OrgType } from '@fp/domain';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import type { Ctx } from '../platform/route.js';
import { ApiError, conflict, forbidden, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { audit, notify } from '../platform/events.js';
import { newToken, sha256 } from '../platform/crypto.js';
import { mediaUrl } from '../platform/storage.js';

const Uuid = z.uuid();
const INVITATION_TTL_MS = 7 * 24 * 3_600_000;
const MAX_OWNED = 5;
const MAX_MEMBERS = 200;

type OrgRow = Selectable<DB['organizations']>;

async function findOrg(deps: Deps, id: string) {
  return deps.db.selectFrom('organizations').selectAll().where('id', '=', id).where('status', '!=', 'deleted').executeTakeFirst();
}

export async function memberRole(db: Deps['db'] | Transaction<DB>, orgId: string, userId: string): Promise<OrgRole | null> {
  const m = await db.selectFrom('organization_members').select('role').where('organization_id', '=', orgId).where('user_id', '=', userId).executeTakeFirst();
  return (m?.role as OrgRole | undefined) ?? null;
}

/**
 * Loads an organization for a member action and checks the actor's role for `action`. Non-members
 * get 403 NOT_A_MEMBER: the organization itself is public, its data is not. A suspended
 * organization is read-only.
 */
export async function orgForAction(ctx: Pick<Ctx<unknown, unknown>, 'deps' | 'me' | 'authorize'>, orgId: string | undefined, action: OrgAction) {
  const parsed = Uuid.safeParse(orgId);
  if (!parsed.success) throw notFound('organization');
  const org = await findOrg(ctx.deps, parsed.data);
  if (!org) throw notFound('organization');
  const role = await memberRole(ctx.deps.db, org.id, ctx.me().userId);
  ctx.authorize({ kind: 'org.act', role, action });
  if (org.status === 'suspended' && action !== 'org.read') throw forbidden('ORG_SUSPENDED', 'this organization is suspended');
  return { org, role: role! };
}

export function publicView(deps: Deps, o: OrgRow, myRole: OrgRole | null): z.input<typeof OrganizationPublicView> {
  return {
    id: o.id, name: o.name, type: o.type as OrgType, country: o.country_code, verified: o.verified_at !== null,
    logoKey: o.logo_key, logoUrl: o.logo_key ? mediaUrl(deps.config.CDN_BASE_URL, o.logo_key) : null, myRole,
  };
}

/** For an organization verification request: the organization, if the actor is its owner or an admin. */
export async function organizationVerificationTarget(deps: Deps, me: Actor, orgId: string | undefined) {
  if (!orgId) throw new ApiError(400, 'ORGANIZATION_REQUIRED', 'choose the organization to verify');
  const org = await findOrg(deps, orgId);
  if (!org || org.status !== 'active') throw notFound('organization');
  const role = await memberRole(deps.db, org.id, me.userId);
  if (role !== 'owner' && role !== 'admin') throw forbidden('ORG_ROLE_REQUIRED', 'only the owner or an admin can ask to verify an organization');
  if (org.verified_at) throw conflict('ALREADY_VERIFIED', 'this organization is already verified');
  return org;
}

/** Erases an organization's pipeline, notes, stage history and saved searches. */
async function eraseOrganizationData(tx: Transaction<DB>, orgId: string) {
  await tx.deleteFrom('crm_entries').where('organization_id', '=', orgId).execute();
  await tx.deleteFrom('saved_searches').where('organization_id', '=', orgId).execute();
  await tx.updateTable('organization_invitations').set({ status: 'revoked' }).where('organization_id', '=', orgId).where('status', '=', 'pending').execute();
  await tx.deleteFrom('organization_members').where('organization_id', '=', orgId).execute();
}

/**
 * Account deletion: the person leaves every organization. An organization they own passes to its
 * longest-standing admin (or, failing that, member); with nobody left it is deleted and erased.
 */
export async function removeFromOrganizations(tx: Transaction<DB>, userId: string, now: Date) {
  const memberships = await tx.selectFrom('organization_members').select(['organization_id', 'role']).where('user_id', '=', userId).execute();
  for (const m of memberships) {
    await tx.deleteFrom('organization_members').where('organization_id', '=', m.organization_id).where('user_id', '=', userId).execute();
    await audit(tx, { actorId: userId, action: 'org.member_left', targetKind: 'organization', targetId: m.organization_id, metadata: { userId, role: m.role, reason: 'account_deleted' } });
    if (m.role !== 'owner') continue;
    const heir = await tx.selectFrom('organization_members').select('user_id').where('organization_id', '=', m.organization_id)
      .orderBy((eb) => eb.case().when('role', '=', 'admin').then(0).else(1).end()).orderBy('created_at').executeTakeFirst();
    if (heir) {
      await tx.updateTable('organization_members').set({ role: 'owner', updated_at: now }).where('organization_id', '=', m.organization_id).where('user_id', '=', heir.user_id).execute();
      await audit(tx, { actorId: null, action: 'org.ownership_transferred', targetKind: 'organization', targetId: m.organization_id, metadata: { from: userId, to: heir.user_id, reason: 'account_deleted' } });
      await notify(tx, heir.user_id, 'org.ownership_received', { organizationId: m.organization_id });
    } else {
      await eraseOrganizationData(tx, m.organization_id);
      await tx.updateTable('organizations').set({ status: 'deleted', deleted_at: now, updated_at: now }).where('id', '=', m.organization_id).execute();
      await audit(tx, { actorId: null, action: 'org.deleted', targetKind: 'organization', targetId: m.organization_id, metadata: { reason: 'owner_account_deleted' } });
    }
  }
  await tx.deleteFrom('crm_entries').where('owner_user_id', '=', userId).execute();
  await tx.deleteFrom('saved_searches').where('owner_user_id', '=', userId).execute();
  // Cards about a deleted player disappear from every pipeline.
  await tx.deleteFrom('crm_entries').where('player_id', '=', userId).execute();
}

async function invitationViews(deps: Deps, orgId: string): Promise<z.input<typeof OrganizationInvitationView>[]> {
  const now = deps.now();
  const rows = await deps.db.selectFrom('organization_invitations').selectAll().where('organization_id', '=', orgId).where('status', '=', 'pending')
    .orderBy('created_at', 'desc').limit(200).execute();
  return rows.map((r) => ({
    id: r.id, email: r.email, role: r.role as never, status: (r.expires_at.getTime() < now.getTime() ? 'expired' : 'pending') as never,
    expiresAt: r.expires_at.toISOString(), createdAt: r.created_at.toISOString(),
  }));
}

/** An invitation found by its token, valid and addressed to the caller's verified email. */
async function invitationForCaller(ctx: Ctx<unknown, { token: string }>) {
  const inv = await ctx.deps.db.selectFrom('organization_invitations').selectAll().where('token_hash', '=', sha256(ctx.body.token)).executeTakeFirst();
  if (inv && inv.status === 'pending' && inv.expires_at.getTime() < ctx.deps.now().getTime()) {
    await ctx.deps.db.updateTable('organization_invitations').set({ status: 'expired' }).where('id', '=', inv.id).where('status', '=', 'pending').execute();
  }
  if (!inv || inv.status !== 'pending' || inv.expires_at.getTime() < ctx.deps.now().getTime()) {
    throw new ApiError(410, 'INVITATION_INVALID', 'this invitation is invalid or has expired');
  }
  // Bound to the email it was sent to, and that email must be verified.
  const email = ctx.identity?.email?.toLowerCase();
  if (!email || !ctx.identity?.emailVerified || email !== inv.email.toLowerCase()) {
    throw forbidden('EMAIL_MISMATCH', 'sign in with the verified email address the invitation was sent to');
  }
  const org = await findOrg(ctx.deps, inv.organization_id);
  if (!org || org.status !== 'active') throw new ApiError(410, 'INVITATION_INVALID', 'this invitation is invalid or has expired');
  return { inv, org };
}

const memberTarget = (id: string | undefined) => {
  const parsed = Uuid.safeParse(id);
  if (!parsed.success) throw notFound('member');
  return parsed.data;
};

export const orgRoutes = [
  route(
    { method: 'post', path: '/v1/orgs', summary: 'Create an organization (you become its owner)', tag: 'organizations', auth: 'user', body: CreateOrganizationRequest, response: OrganizationPublicView, status: 201, rateLimit: { max: 10, timeWindow: '1 day' } },
    async (ctx) => {
      ctx.authorize({ kind: 'org.create' });
      const me = ctx.me();
      const owned = await ctx.deps.db.selectFrom('organization_members').innerJoin('organizations', 'organizations.id', 'organization_members.organization_id')
        .select(ctx.deps.db.fn.countAll<string>().as('n')).where('organization_members.user_id', '=', me.userId)
        .where('organization_members.role', '=', 'owner').where('organizations.status', '!=', 'deleted').executeTakeFirstOrThrow();
      if (Number(owned.n) >= MAX_OWNED) throw new ApiError(400, 'LIMIT_REACHED', `you can own up to ${MAX_OWNED} organizations`);
      const id = newId();
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.insertInto('organizations').values({ id, name: ctx.body.name, type: ctx.body.type, country_code: ctx.body.countryCode ?? null, created_by: me.userId }).execute();
        await tx.insertInto('organization_members').values({ organization_id: id, user_id: me.userId, role: 'owner', added_by: me.userId }).execute();
        await audit(tx, { actorId: me.userId, action: 'org.created', targetKind: 'organization', targetId: id, metadata: { type: ctx.body.type } });
        await audit(tx, { actorId: me.userId, action: 'org.member_added', targetKind: 'organization', targetId: id, metadata: { userId: me.userId, role: 'owner' } });
      });
      return publicView(ctx.deps, (await findOrg(ctx.deps, id))!, 'owner');
    },
  ),

  route(
    { method: 'get', path: '/v1/orgs/mine', summary: 'Organizations I belong to, with my role', tag: 'organizations', auth: 'user', response: MyOrganizations },
    async (ctx) => {
      const rows = await ctx.deps.db.selectFrom('organization_members').innerJoin('organizations', 'organizations.id', 'organization_members.organization_id')
        .selectAll('organizations').select('organization_members.role as my_role')
        .where('organization_members.user_id', '=', ctx.me().userId).where('organizations.status', '!=', 'deleted')
        .orderBy('organizations.name').execute();
      return { items: rows.map((r) => ({ ...publicView(ctx.deps, r, r.my_role as OrgRole), myRole: r.my_role as OrgRole, suspended: r.status === 'suspended' })) };
    },
  ),

  route(
    { method: 'get', path: '/v1/orgs/:orgId', summary: 'Public organization profile (never its members)', tag: 'organizations', auth: 'optional', response: OrganizationPublicView },
    async (ctx) => {
      const parsed = Uuid.safeParse(ctx.params.orgId);
      if (!parsed.success) throw notFound('organization');
      const org = await findOrg(ctx.deps, parsed.data);
      const role = org && ctx.actor ? await memberRole(ctx.deps.db, org.id, ctx.actor.userId) : null;
      const staff = Boolean(ctx.actor?.roles.includes('admin') || ctx.actor?.roles.includes('moderator'));
      // A suspended organization disappears from public view; its members and staff still see it.
      if (!org || (org.status !== 'active' && !role && !staff)) throw notFound('organization');
      return publicView(ctx.deps, org, role);
    },
  ),

  route(
    { method: 'get', path: '/v1/orgs/:orgId/dashboard', summary: 'Organization dashboard: members, invitations, verification (members only)', tag: 'organizations', auth: 'user', response: OrganizationDashboard },
    async (ctx) => {
      const { org, role } = await orgForAction(ctx, ctx.params.orgId, 'org.read');
      const [members, verification] = await Promise.all([
        ctx.deps.db.selectFrom('organization_members').innerJoin('profiles', 'profiles.user_id', 'organization_members.user_id')
          .select(['organization_members.user_id', 'organization_members.role', 'organization_members.created_at', 'profiles.handle', 'profiles.display_name'])
          .where('organization_members.organization_id', '=', org.id).orderBy('organization_members.created_at').execute(),
        ctx.deps.db.selectFrom('verification_requests').select(['status', 'created_at']).where('organization_id', '=', org.id)
          .orderBy('created_at', 'desc').executeTakeFirst(),
      ]);
      const manage = role === 'owner' || role === 'admin';
      return {
        ...publicView(ctx.deps, org, role),
        myRole: role,
        status: org.status as 'active' | 'suspended',
        members: members.map((m) => ({ userId: m.user_id, handle: m.handle, displayName: m.display_name, role: m.role as OrgRole, since: m.created_at.toISOString() })),
        invitations: manage ? await invitationViews(ctx.deps, org.id) : [],
        verification: org.verified_at
          ? { status: 'approved' as const, requestedAt: verification?.created_at.toISOString() ?? null }
          : { status: (verification?.status ?? 'none') as 'none' | 'pending' | 'approved' | 'rejected', requestedAt: verification?.created_at.toISOString() ?? null },
        createdAt: org.created_at.toISOString(),
      };
    },
  ),

  route(
    { method: 'patch', path: '/v1/orgs/:orgId', summary: 'Edit the organization profile (owner or admin)', tag: 'organizations', auth: 'user', body: UpdateOrganizationRequest, response: OrganizationPublicView },
    async (ctx) => {
      const { org, role } = await orgForAction(ctx, ctx.params.orgId, 'members.manage');
      const b = ctx.body;
      if (b.logoKey && !b.logoKey.startsWith(`org-logos/${org.id}/`)) throw new ApiError(400, 'INVALID_LOGO', 'the logo must be stored under this organization');
      const changes = {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.type !== undefined ? { type: b.type } : {}),
        ...(b.countryCode !== undefined ? { country_code: b.countryCode } : {}),
        ...(b.logoKey !== undefined ? { logo_key: b.logoKey } : {}),
      };
      await ctx.deps.db.transaction().execute(async (tx) => {
        // A verified badge vouches for a name and type; changing either needs a new verification.
        const reverify = org.verified_at && ((b.name !== undefined && b.name !== org.name) || (b.type !== undefined && b.type !== org.type));
        await tx.updateTable('organizations').set({ ...changes, ...(reverify ? { verified_at: null } : {}), updated_at: ctx.deps.now() }).where('id', '=', org.id).execute();
        await audit(tx, { actorId: ctx.me().userId, action: 'org.updated', targetKind: 'organization', targetId: org.id, metadata: { fields: Object.keys(changes), verificationCleared: Boolean(reverify) } });
      });
      return publicView(ctx.deps, (await findOrg(ctx.deps, org.id))!, role);
    },
  ),

  route(
    { method: 'delete', path: '/v1/orgs/:orgId', summary: 'Delete the organization and erase its pipeline (owner only)', tag: 'organizations', auth: 'user', body: DeleteOrganizationRequest, status: 204 },
    async (ctx) => {
      const { org } = await orgForAction(ctx, ctx.params.orgId, 'org.owner');
      const now = ctx.deps.now();
      await ctx.deps.db.transaction().execute(async (tx) => {
        const members = await tx.selectFrom('organization_members').select('user_id').where('organization_id', '=', org.id).execute();
        await eraseOrganizationData(tx, org.id);
        await tx.updateTable('organizations').set({ status: 'deleted', deleted_at: now, updated_at: now }).where('id', '=', org.id).execute();
        for (const m of members) if (m.user_id !== ctx.me().userId) await notify(tx, m.user_id, 'org.deleted', { organizationId: org.id, name: org.name });
        await audit(tx, { actorId: ctx.me().userId, action: 'org.deleted', targetKind: 'organization', targetId: org.id, metadata: { members: members.length } });
      });
    },
  ),

  route(
    { method: 'post', path: '/v1/orgs/:orgId/transfer', summary: 'Transfer ownership to another member (owner only)', tag: 'organizations', auth: 'user', body: TransferOwnershipRequest, status: 204 },
    async (ctx) => {
      const { org } = await orgForAction(ctx, ctx.params.orgId, 'org.owner');
      const me = ctx.me();
      if (ctx.body.userId === me.userId) throw new ApiError(400, 'SELF_ACTION', 'you already own this organization');
      await ctx.deps.db.transaction().execute(async (tx) => {
        const target = await memberRole(tx, org.id, ctx.body.userId);
        if (!target) throw notFound('member');
        const now = ctx.deps.now();
        // The one-owner index requires the old owner to step down first.
        await tx.updateTable('organization_members').set({ role: 'admin', updated_at: now }).where('organization_id', '=', org.id).where('user_id', '=', me.userId).execute();
        await tx.updateTable('organization_members').set({ role: 'owner', updated_at: now }).where('organization_id', '=', org.id).where('user_id', '=', ctx.body.userId).execute();
        await audit(tx, { actorId: me.userId, action: 'org.ownership_transferred', targetKind: 'organization', targetId: org.id, metadata: { from: me.userId, to: ctx.body.userId, previousRole: target } });
        await notify(tx, ctx.body.userId, 'org.ownership_received', { organizationId: org.id, name: org.name });
      });
    },
  ),

  route(
    { method: 'post', path: '/v1/orgs/:orgId/invitations', summary: 'Invite someone by email (owner or admin)', tag: 'organizations', auth: 'user', body: CreateOrgInvitationRequest, response: CreateOrgInvitationResponse, status: 201, rateLimit: { max: 50, timeWindow: '1 day' } },
    async (ctx) => {
      const { org, role } = await orgForAction(ctx, ctx.params.orgId, 'members.manage');
      const me = ctx.me();
      const { email, role: invitedRole } = ctx.body;
      if (!canManageMember(role, null, invitedRole)) throw forbidden('ORG_ROLE_REQUIRED', 'only the owner can invite admins');
      const existing = await ctx.deps.db.selectFrom('organization_members').innerJoin('users', 'users.id', 'organization_members.user_id')
        .select('users.id').where('organization_members.organization_id', '=', org.id).where('users.email', '=', email).executeTakeFirst();
      if (existing) throw conflict('ALREADY_MEMBER', 'this person is already a member');
      const count = await ctx.deps.db.selectFrom('organization_members').select(ctx.deps.db.fn.countAll<string>().as('n')).where('organization_id', '=', org.id).executeTakeFirstOrThrow();
      if (Number(count.n) >= MAX_MEMBERS) throw new ApiError(400, 'LIMIT_REACHED', `an organization can have up to ${MAX_MEMBERS} members`);
      const id = newId();
      const token = newToken();
      const expiresAt = new Date(ctx.deps.now().getTime() + INVITATION_TTL_MS);
      await ctx.deps.db.transaction().execute(async (tx) => {
        // Inviting the same address again replaces the earlier invitation (its link stops working).
        await tx.updateTable('organization_invitations').set({ status: 'revoked' }).where('organization_id', '=', org.id).where('email', '=', email).where('status', '=', 'pending').execute();
        await tx.insertInto('organization_invitations').values({
          id, organization_id: org.id, email, role: invitedRole, token_hash: sha256(token), invited_by: me.userId, expires_at: expiresAt,
        }).execute();
        await audit(tx, { actorId: me.userId, action: 'org.member_invited', targetKind: 'organization', targetId: org.id, metadata: { invitationId: id, role: invitedRole } });
      });
      const locale = (await ctx.deps.db.selectFrom('users').select('locale').where('id', '=', me.userId).executeTakeFirst())?.locale === 'ar' ? 'ar' : 'en';
      await ctx.deps.mailer.sendOrganizationInvitation(email, org.name, invitedRole, token, locale);
      return { invitationId: id, expiresAt: expiresAt.toISOString() };
    },
  ),

  route(
    { method: 'get', path: '/v1/orgs/:orgId/invitations', summary: 'Pending invitations (owner or admin)', tag: 'organizations', auth: 'user', response: z.object({ items: z.array(OrganizationInvitationView) }) },
    async (ctx) => {
      const { org } = await orgForAction(ctx, ctx.params.orgId, 'members.manage');
      return { items: await invitationViews(ctx.deps, org.id) };
    },
  ),

  route(
    { method: 'delete', path: '/v1/orgs/:orgId/invitations/:invitationId', summary: 'Revoke an invitation (owner or admin)', tag: 'organizations', auth: 'user', status: 204 },
    async (ctx) => {
      const { org, role } = await orgForAction(ctx, ctx.params.orgId, 'members.manage');
      const id = Uuid.safeParse(ctx.params.invitationId);
      const inv = id.success
        ? await ctx.deps.db.selectFrom('organization_invitations').selectAll().where('id', '=', id.data).where('organization_id', '=', org.id).where('status', '=', 'pending').executeTakeFirst()
        : undefined;
      if (!inv) throw notFound('invitation');
      if (!canManageMember(role, null, inv.role as OrgRole)) throw forbidden('ORG_ROLE_REQUIRED', 'only the owner can revoke an admin invitation');
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.updateTable('organization_invitations').set({ status: 'revoked', responded_at: ctx.deps.now() }).where('id', '=', inv.id).execute();
        await audit(tx, { actorId: ctx.me().userId, action: 'org.invitation_revoked', targetKind: 'organization', targetId: org.id, metadata: { invitationId: inv.id, role: inv.role } });
      });
    },
  ),

  route(
    { method: 'post', path: '/v1/org-invitations/accept', summary: 'Accept an organization invitation', tag: 'organizations', auth: 'user', body: OrgInvitationTokenRequest, response: AcceptOrgInvitationResponse, rateLimit: { max: 20, timeWindow: '1 hour' } },
    async (ctx) => {
      const me = ctx.me();
      // Pipelines hold notes about players: organizations are for adults.
      if (isMinor(me.ageBand)) throw forbidden('ADULTS_ONLY', 'organizations are for adults');
      ctx.authorize({ kind: 'org.create' });
      const { inv, org } = await invitationForCaller(ctx);
      await ctx.deps.db.transaction().execute(async (tx) => {
        const claimed = await tx.updateTable('organization_invitations').set({ status: 'accepted', responded_at: ctx.deps.now(), responded_by: me.userId })
          .where('id', '=', inv.id).where('status', '=', 'pending').returning('id').executeTakeFirst();
        if (!claimed) throw new ApiError(410, 'INVITATION_INVALID', 'this invitation is invalid or has expired');
        if (await memberRole(tx, org.id, me.userId)) throw conflict('ALREADY_MEMBER', 'you are already a member');
        await tx.insertInto('organization_members').values({ organization_id: org.id, user_id: me.userId, role: inv.role, added_by: inv.invited_by }).execute();
        await audit(tx, { actorId: me.userId, action: 'org.invitation_accepted', targetKind: 'organization', targetId: org.id, metadata: { invitationId: inv.id, role: inv.role } });
        await audit(tx, { actorId: me.userId, action: 'org.member_added', targetKind: 'organization', targetId: org.id, metadata: { userId: me.userId, role: inv.role, invitedBy: inv.invited_by } });
        if (inv.invited_by) await notify(tx, inv.invited_by, 'org.invitation_accepted', { organizationId: org.id, userId: me.userId });
      });
      return { organizationId: org.id, role: inv.role as never };
    },
  ),

  route(
    { method: 'post', path: '/v1/org-invitations/decline', summary: 'Decline an organization invitation', tag: 'organizations', auth: 'user', body: OrgInvitationTokenRequest, status: 204 },
    async (ctx) => {
      const { inv, org } = await invitationForCaller(ctx);
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.updateTable('organization_invitations').set({ status: 'declined', responded_at: ctx.deps.now(), responded_by: ctx.me().userId }).where('id', '=', inv.id).execute();
        await audit(tx, { actorId: ctx.me().userId, action: 'org.invitation_declined', targetKind: 'organization', targetId: org.id, metadata: { invitationId: inv.id } });
      });
    },
  ),

  route(
    { method: 'patch', path: '/v1/orgs/:orgId/members/:userId', summary: 'Change a member’s role (owner, or admin for roles below admin)', tag: 'organizations', auth: 'user', body: UpdateOrgMemberRequest, status: 204 },
    async (ctx) => {
      const { org, role } = await orgForAction(ctx, ctx.params.orgId, 'members.manage');
      const userId = memberTarget(ctx.params.userId);
      const me = ctx.me();
      await ctx.deps.db.transaction().execute(async (tx) => {
        const current = await memberRole(tx, org.id, userId);
        if (!current) throw notFound('member');
        if (!canManageMember(role, current, ctx.body.role, userId === me.userId)) throw forbidden('ORG_ROLE_REQUIRED', 'you cannot change this member’s role');
        if (current === ctx.body.role) return;
        await tx.updateTable('organization_members').set({ role: ctx.body.role, updated_at: ctx.deps.now() }).where('organization_id', '=', org.id).where('user_id', '=', userId).execute();
        await audit(tx, { actorId: me.userId, action: 'org.member_role_changed', targetKind: 'organization', targetId: org.id, metadata: { userId, from: current, to: ctx.body.role } });
        await notify(tx, userId, 'org.role_changed', { organizationId: org.id, name: org.name, role: ctx.body.role });
      });
    },
  ),

  route(
    { method: 'delete', path: '/v1/orgs/:orgId/members/:userId', summary: 'Remove a member (owner, or admin for roles below admin)', tag: 'organizations', auth: 'user', status: 204 },
    async (ctx) => {
      const { org, role } = await orgForAction(ctx, ctx.params.orgId, 'members.manage');
      const userId = memberTarget(ctx.params.userId);
      const me = ctx.me();
      await ctx.deps.db.transaction().execute(async (tx) => {
        const current = await memberRole(tx, org.id, userId);
        if (!current) throw notFound('member');
        if (!canManageMember(role, current, null, userId === me.userId)) throw forbidden('ORG_ROLE_REQUIRED', 'you cannot remove this member');
        await tx.deleteFrom('organization_members').where('organization_id', '=', org.id).where('user_id', '=', userId).execute();
        await audit(tx, { actorId: me.userId, action: 'org.member_removed', targetKind: 'organization', targetId: org.id, metadata: { userId, role: current } });
        await notify(tx, userId, 'org.removed', { organizationId: org.id, name: org.name });
      });
    },
  ),

  route(
    { method: 'post', path: '/v1/orgs/:orgId/leave', summary: 'Leave an organization (the owner must transfer ownership first)', tag: 'organizations', auth: 'user', status: 204 },
    async (ctx) => {
      const { org, role } = await orgForAction(ctx, ctx.params.orgId, 'org.read');
      if (role === 'owner') throw conflict('OWNER_MUST_TRANSFER', 'transfer ownership before leaving, or delete the organization');
      const me = ctx.me();
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.deleteFrom('organization_members').where('organization_id', '=', org.id).where('user_id', '=', me.userId).execute();
        await audit(tx, { actorId: me.userId, action: 'org.member_left', targetKind: 'organization', targetId: org.id, metadata: { userId: me.userId, role } });
      });
    },
  ),
];
