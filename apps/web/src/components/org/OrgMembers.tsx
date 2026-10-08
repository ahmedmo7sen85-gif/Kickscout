'use client';

import Link from 'next/link';
import { canManageMember, INVITABLE_ORG_ROLES } from '@fp/domain';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/lib/i18n/provider';
import type { InvitableOrgRole, OrganizationMemberView, OrgRole } from '@/lib/types';

/** Member list. Role and remove controls appear only where the API would allow them (same rule, from @fp/domain). */
export function OrgMembers({ members, myRole, myUserId, busyId, onRoleChange, onRemove }: {
  members: OrganizationMemberView[]; myRole: OrgRole; myUserId: string | null; busyId?: string | null;
  onRoleChange?: (m: OrganizationMemberView, role: InvitableOrgRole) => void; onRemove?: (m: OrganizationMemberView) => void;
}) {
  const { t, fmt, formatDate } = useI18n();
  return (
    <ul className="list" data-testid="org-members">
      {members.map((m) => {
        const self = m.userId === myUserId;
        const canRemove = canManageMember(myRole, m.role, null, self);
        const choices = INVITABLE_ORG_ROLES.filter((r) => r === m.role || canManageMember(myRole, m.role, r, self));
        const canChange = choices.some((r) => r !== m.role);
        return (
          <li key={m.userId} className="list__row">
            <span>
              <Link className="link" href={`/u/${m.handle}`}>@{m.handle}</Link> <span className="muted small" dir="auto">{m.displayName}</span>
              <span className="muted small"> · {fmt(t.org.since, { date: formatDate(m.since) })}</span>
            </span>
            <span className="row">
              {canChange ? (
                <>
                  <label className="sr-only" htmlFor={`role-${m.userId}`}>{fmt(t.org.changeRole, { name: m.displayName })}</label>
                  <select id={`role-${m.userId}`} className="input input--sm" value={m.role} disabled={busyId === m.userId}
                    onChange={(e) => onRoleChange?.(m, e.target.value as InvitableOrgRole)}>
                    {choices.map((r) => <option key={r} value={r}>{t.orgRoles[r]}</option>)}
                  </select>
                </>
              ) : <span className="badge badge--outline">{t.orgRoles[m.role]}</span>}
              {canRemove ? (
                <Button size="sm" variant="ghost" disabled={busyId === m.userId} aria-label={fmt(t.org.removeMember, { name: m.displayName })} onClick={() => onRemove?.(m)}>
                  {t.common.remove}
                </Button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
