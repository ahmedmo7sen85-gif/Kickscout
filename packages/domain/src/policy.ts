/**
 * Server-side authorization. Every handler calls `can()`; the client's view of roles is cosmetic.
 */
import { isMinor } from './age.js';
import type { AgeBand } from './age.js';

export type Role = 'player' | 'fan' | 'scout' | 'moderator' | 'admin';
export type UserStatus = 'pending_consent' | 'active' | 'suspended' | 'deleted';
export type ConsentPurpose = 'account' | 'public_profile' | 'scout_contact' | 'model_training';

export interface Actor {
  userId: string;
  roles: readonly Role[];
  status: UserStatus;
  ageBand: AgeBand;
  mfa: boolean;
  /** Users this actor is an active guardian of. */
  guardianOf: readonly string[];
  /** Consents currently granted for this actor (as subject). */
  consents: ReadonlySet<ConsentPurpose>;
}

export type Action =
  | { kind: 'video.upload' }
  | { kind: 'video.delete'; ownerId: string }
  | { kind: 'video.edit'; ownerId: string }
  | { kind: 'scout.use' }
  | { kind: 'scout.contact'; playerId: string; playerAcceptsContact: boolean }
  | { kind: 'challenge.enter'; videoOwnerId: string }
  | { kind: 'profile.update'; subjectId: string }
  /** `loosens`: the change exposes more (see loosensPrivacy). `opensProfile`: anything other than private. */
  | { kind: 'privacy.update'; subjectId: string; subjectMinor: boolean; loosens: boolean; opensProfile: boolean; publicProfileConsent: boolean }
  | { kind: 'account.delete'; subjectId: string; subjectMinor: boolean; subjectHasGuardian: boolean }
  | { kind: 'copyright.counter_notice'; ownerId: string; ownerMinor: boolean }
  | { kind: 'comment.create'; videoOwnerId: string; commentsSetting: 'everyone' | 'followers' | 'off'; isFollower: boolean; blocked: boolean }
  /** Buying a paid plan for `subjectId` (yourself, or a ward as their guardian). */
  | { kind: 'billing.purchase'; subjectId: string; subjectMinor: boolean }
  | { kind: 'social.engage' }
  | { kind: 'report.create' }
  | { kind: 'consent.grant'; subjectId: string; purpose: ConsentPurpose }
  | { kind: 'admin.access' }
  | { kind: 'moderation.act' }
  | { kind: 'verification.decide' }
  | { kind: 'challenge.manage' };

export type Decision = { allowed: true } | { allowed: false; code: string; reason: string };

const allow: Decision = { allowed: true };
const deny = (code: string, reason: string): Decision => ({ allowed: false, code, reason });

const UPLOAD_ROLES: ReadonlySet<Role> = new Set(['player']);

const has = (a: Actor, r: Role) => a.roles.includes(r);
const isStaff = (a: Actor) => has(a, 'admin') || has(a, 'moderator');
const isSelfOrGuardian = (a: Actor, subjectId: string) => a.userId === subjectId || a.guardianOf.includes(subjectId);

export function can(actor: Actor, action: Action): Decision {
  if (actor.status === 'deleted' || actor.status === 'suspended') return deny('ACCOUNT_INACTIVE', 'account is not active');

  // Accounts awaiting guardian consent may only view their own state, record consent, or ask to be deleted.
  if (actor.status === 'pending_consent' && action.kind !== 'consent.grant' && action.kind !== 'account.delete') {
    return deny('CONSENT_REQUIRED', 'guardian consent is required before using the platform');
  }

  switch (action.kind) {
    case 'video.upload':
      return actor.roles.some((r) => UPLOAD_ROLES.has(r)) ? allow : deny('ROLE_REQUIRED', 'this role cannot upload');

    case 'video.delete':
      return isSelfOrGuardian(actor, action.ownerId) || isStaff(actor) ? allow : deny('FORBIDDEN', 'not the owner');

    case 'video.edit':
      return isSelfOrGuardian(actor, action.ownerId) ? allow : deny('FORBIDDEN', 'not the owner');

    case 'challenge.enter':
      return isSelfOrGuardian(actor, action.videoOwnerId) ? allow : deny('FORBIDDEN', 'only the uploader can enter a challenge');

    case 'scout.use':
      // The scout role exists only after staff approve a verification request.
      return has(actor, 'scout') || has(actor, 'admin') ? allow : deny('SCOUT_VERIFICATION_REQUIRED', 'verified scouts only');

    case 'scout.contact':
      if (!has(actor, 'scout')) return deny('SCOUT_VERIFICATION_REQUIRED', 'verified scouts only');
      if (actor.userId === action.playerId) return deny('FORBIDDEN', 'cannot contact yourself');
      // For a minor this consent can only have come from their guardian (see consent.grant).
      return action.playerAcceptsContact ? allow : deny('CONTACT_NOT_ALLOWED', 'this player does not accept scout contact');

    case 'profile.update':
      return isSelfOrGuardian(actor, action.subjectId) || has(actor, 'admin') ? allow : deny('FORBIDDEN', 'not your profile');

    case 'privacy.update': {
      const guardianOrAdmin = actor.guardianOf.includes(action.subjectId) || has(actor, 'admin');
      if (actor.userId !== action.subjectId && !guardianOrAdmin) return deny('FORBIDDEN', 'not your settings');
      if (!action.subjectMinor) return allow;
      // A minor's profile opens only on the guardian's public-profile consent, and only the guardian
      // may loosen any other setting. A minor can always make their own settings stricter.
      if (action.opensProfile && !action.publicProfileConsent) return deny('GUARDIAN_REQUIRED', 'a guardian must approve a visible profile first');
      if (action.loosens && !guardianOrAdmin) return deny('GUARDIAN_REQUIRED', 'your guardian must approve this change');
      return allow;
    }

    case 'account.delete':
      if (actor.guardianOf.includes(action.subjectId)) return allow;
      if (actor.userId !== action.subjectId) return deny('FORBIDDEN', 'not your account');
      // Where a guardian is linked, a minor's deletion waits for them (the account is hidden meanwhile).
      return action.subjectMinor && action.subjectHasGuardian ? deny('GUARDIAN_REQUIRED', 'your guardian must confirm the deletion') : allow;

    case 'copyright.counter_notice':
      if (actor.guardianOf.includes(action.ownerId)) return allow;
      if (actor.userId !== action.ownerId) return deny('FORBIDDEN', 'not your video');
      // A counter-notice is a legal statement; for a minor the guardian makes it.
      return action.ownerMinor ? deny('GUARDIAN_REQUIRED', 'a guardian must file this for a minor') : allow;

    case 'billing.purchase':
      // Minors never pay: a guardian buys for them, from the guardian's own account.
      if (isMinor(actor.ageBand)) return deny('GUARDIAN_REQUIRED', 'a guardian must make purchases for you');
      if (actor.guardianOf.includes(action.subjectId)) return allow;
      if (actor.userId !== action.subjectId) return deny('FORBIDDEN', 'cannot buy a plan for another user');
      return action.subjectMinor ? deny('GUARDIAN_REQUIRED', 'a guardian must make purchases for you') : allow;

    case 'comment.create':
      if (action.blocked) return deny('BLOCKED', 'you cannot comment here');
      if (action.videoOwnerId === actor.userId) return allow;
      if (action.commentsSetting === 'off') return deny('COMMENTS_OFF', 'comments are turned off');
      if (action.commentsSetting === 'followers' && !action.isFollower) return deny('FOLLOWERS_ONLY', 'only followers can comment');
      return allow;

    case 'social.engage':
    case 'report.create':
      return allow;

    case 'consent.grant': {
      const subjectIsActor = action.subjectId === actor.userId;
      if (actor.guardianOf.includes(action.subjectId)) return allow;
      if (!subjectIsActor) return deny('FORBIDDEN', 'cannot consent for another user');
      // A minor cannot grant their own consents; their guardian does.
      return isMinor(actor.ageBand) ? deny('GUARDIAN_REQUIRED', 'a guardian must grant this consent') : allow;
    }

    case 'admin.access':
      if (!has(actor, 'admin')) return deny('FORBIDDEN', 'admins only');
      return actor.mfa ? allow : deny('MFA_REQUIRED', 'admin access requires MFA');

    case 'moderation.act':
      if (!isStaff(actor)) return deny('FORBIDDEN', 'moderators only');
      return actor.mfa ? allow : deny('MFA_REQUIRED', 'moderation requires MFA');

    case 'verification.decide':
    case 'challenge.manage':
      if (!has(actor, 'admin')) return deny('FORBIDDEN', 'admins only');
      return actor.mfa ? allow : deny('MFA_REQUIRED', 'admin actions require MFA');
  }
}
