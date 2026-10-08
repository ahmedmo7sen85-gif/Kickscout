/**
 * Organizations and the scout CRM: member roles, what each role may do, and the recruitment
 * pipeline's stages. Pure rules; the API loads the member's role and asks `orgCan`.
 */

export const ORG_TYPES = ['academy', 'club', 'agency', 'school', 'other'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

/** Highest first. */
export const ORG_ROLES = ['owner', 'admin', 'scout', 'analyst', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
/** Roles an invitation or a role change can grant. Ownership moves only by transfer. */
export const INVITABLE_ORG_ROLES = ['admin', 'scout', 'analyst', 'viewer'] as const satisfies readonly OrgRole[];

const RANK: Record<OrgRole, number> = { owner: 4, admin: 3, scout: 2, analyst: 1, viewer: 0 };
export const roleRank = (r: OrgRole) => RANK[r];

export type OrgAction =
  /** See the dashboard, members, pipeline, notes and saved searches. */
  | 'org.read'
  /** Write and delete own notes on pipeline cards. */
  | 'crm.note'
  /** Add players, move stages, tag, request contact, manage saved searches. */
  | 'crm.write'
  /** Invite, change roles of and remove members below oneself; see invitations; edit the profile; request verification. */
  | 'members.manage'
  /** Delete the organization or transfer ownership. */
  | 'org.owner';

const MIN_ROLE: Record<OrgAction, OrgRole> = {
  'org.read': 'viewer',
  'crm.note': 'analyst',
  'crm.write': 'scout',
  'members.manage': 'admin',
  'org.owner': 'owner',
};

/** True when a member with `role` may perform `action`. Non-members (null) may do nothing. */
export function orgCan(role: OrgRole | null | undefined, action: OrgAction): boolean {
  return role != null && RANK[role] >= RANK[MIN_ROLE[action]];
}

/**
 * Whether `actor` may give `target` (currently `current`, null for an invitation) the role `next`, or
 * remove them (`next` null). Only the owner touches admins; nobody changes the owner or grants
 * ownership this way; nobody changes their own role.
 */
export function canManageMember(actor: OrgRole | null, current: OrgRole | null, next: OrgRole | null, self = false): boolean {
  if (!orgCan(actor, 'members.manage') || self) return false;
  if (current === 'owner' || next === 'owner') return false;
  const top = Math.max(current ? RANK[current] : -1, next ? RANK[next] : -1);
  return actor === 'owner' ? true : top < RANK.admin;
}

// ---------------------------------------------------------------- pipeline

export const CRM_STAGES = ['new', 'watching', 'shortlisted', 'monitoring', 'contact_requested', 'contacted', 'evaluation', 'archived'] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

export type StageMove =
  | { ok: true; via: 'direct' | 'contact_request' }
  | { ok: false; code: 'SAME_STAGE' | 'CONTACT_NOT_ACCEPTED'; reason: string };

/**
 * Whether a card may move from `from` to `to`. Moving to contact_requested always goes through the
 * contact-request flow (with its consent, privacy and guardian rules); contacted needs an accepted
 * request; evaluation follows contact.
 */
export function stageMove(from: CrmStage, to: CrmStage, contactAccepted: boolean): StageMove {
  if (from === to) return { ok: false, code: 'SAME_STAGE', reason: 'the card is already in this stage' };
  if (to === 'contact_requested') return { ok: true, via: 'contact_request' };
  if ((to === 'contacted' || to === 'evaluation') && !contactAccepted) {
    return { ok: false, code: 'CONTACT_NOT_ACCEPTED', reason: 'the player (or their guardian) has not accepted a contact request yet' };
  }
  return { ok: true, via: 'direct' };
}

/** Tags are short labels; normalised to lower case, deduplicated, at most 20. */
export function normaliseTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}
