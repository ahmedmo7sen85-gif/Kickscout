/**
 * Server-side authorization. Every handler calls `can()`; the client's view of roles is cosmetic.
 */
import { isMinor } from './age.js';
import type { AgeBand } from './age.js';

export type Role = 'player' | 'fan' | 'creator' | 'coach' | 'scout' | 'academy' | 'club' | 'moderator' | 'admin';
export type UserStatus = 'pending_consent' | 'active' | 'suspended' | 'deleted';
export type ConsentPurpose = 'account' | 'public_profile' | 'ai_analysis' | 'model_training' | 'leaderboards' | 'scout_contact';

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
  | { kind: 'analysis.request'; videoOwnerId: string }
  | { kind: 'analysis.view'; subjectId: string; subjectPublic: boolean; subjectAgeBand: AgeBand }
  | { kind: 'selection.confirm'; claimedPlayerId: string }
  | { kind: 'profile.update'; subjectId: string }
  | { kind: 'comment.create'; videoOwnerId: string; commentsSetting: 'everyone' | 'followers' | 'off'; isFollower: boolean; blocked: boolean }
  | { kind: 'social.engage' }
  | { kind: 'report.create' }
  | { kind: 'consent.grant'; subjectId: string; purpose: ConsentPurpose }
  | { kind: 'admin.access' }
  | { kind: 'moderation.act' };

export type Decision = { allowed: true } | { allowed: false; code: string; reason: string };

const allow: Decision = { allowed: true };
const deny = (code: string, reason: string): Decision => ({ allowed: false, code, reason });

const UPLOAD_ROLES: ReadonlySet<Role> = new Set(['player', 'creator', 'coach', 'academy', 'club']);

const has = (a: Actor, r: Role) => a.roles.includes(r);
const isStaff = (a: Actor) => has(a, 'admin') || has(a, 'moderator');
const isSelfOrGuardian = (a: Actor, subjectId: string) => a.userId === subjectId || a.guardianOf.includes(subjectId);

export function can(actor: Actor, action: Action): Decision {
  if (actor.status === 'deleted' || actor.status === 'suspended') return deny('ACCOUNT_INACTIVE', 'account is not active');

  // Accounts awaiting guardian consent may only view their own state and record consent.
  if (actor.status === 'pending_consent' && action.kind !== 'consent.grant') {
    return deny('CONSENT_REQUIRED', 'guardian consent is required before using the platform');
  }

  switch (action.kind) {
    case 'video.upload':
      return actor.roles.some((r) => UPLOAD_ROLES.has(r)) ? allow : deny('ROLE_REQUIRED', 'this role cannot upload');

    case 'video.delete':
      return isSelfOrGuardian(actor, action.ownerId) || isStaff(actor) ? allow : deny('FORBIDDEN', 'not the owner');

    case 'analysis.request':
      if (!isSelfOrGuardian(actor, action.videoOwnerId)) return deny('FORBIDDEN', 'only the uploader can request analysis');
      return actor.consents.has('ai_analysis') ? allow : deny('CONSENT_REQUIRED', 'AI analysis consent is not granted');

    case 'analysis.view':
      if (isSelfOrGuardian(actor, action.subjectId) || has(actor, 'admin')) return allow;
      if (!action.subjectPublic) return deny('FORBIDDEN', 'analysis is private');
      // Minors' analyses are visible to verified scouts only, never to the general public.
      if (isMinor(action.subjectAgeBand)) {
        return has(actor, 'scout') || has(actor, 'academy') || has(actor, 'club')
          ? allow
          : deny('FORBIDDEN', "a minor's analysis is not public");
      }
      return allow;

    case 'selection.confirm':
      // Identity is never inferred: only the claimed player (or their guardian) can confirm it is them.
      return isSelfOrGuardian(actor, action.claimedPlayerId) ? allow : deny('FORBIDDEN', 'only the player can confirm');

    case 'profile.update':
      return isSelfOrGuardian(actor, action.subjectId) || has(actor, 'admin') ? allow : deny('FORBIDDEN', 'not your profile');

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
  }
}
