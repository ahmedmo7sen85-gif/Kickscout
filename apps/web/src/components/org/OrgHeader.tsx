'use client';

import { Badge, VerifiedBadge } from '@/components/ui/Badge';
import { useI18n } from '@/lib/i18n/provider';
import type { OrganizationPublicView } from '@/lib/types';

/** The public face of an organization: name, type, country, verified badge, logo. Never its members. */
export function OrgHeader({ org }: { org: OrganizationPublicView }) {
  const { t } = useI18n();
  return (
    <header className="page-head" data-testid="org-header">
      <div className="kicker">{t.orgTypes[org.type]}{org.country ? ` · ${org.country}` : ''}</div>
      <div className="row">
        {org.logoUrl ? <img src={org.logoUrl} alt="" width={56} height={56} style={{ borderRadius: 12, objectFit: 'cover' }} /> : null}
        <h1 className="page-title" dir="auto">{org.name}</h1>
        {org.verified ? <VerifiedBadge /> : null}
        {org.myRole ? <Badge tone="outline">{t.orgRoles[org.myRole]}</Badge> : null}
      </div>
      <p className="muted small">{t.org.publicNote}</p>
    </header>
  );
}
