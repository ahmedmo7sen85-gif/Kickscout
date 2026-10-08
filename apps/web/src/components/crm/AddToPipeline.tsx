'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { OrgRole } from '@/lib/types';

const WRITE_ROLES: readonly OrgRole[] = ['owner', 'admin', 'scout'];

/** "Add to pipeline" for a verified scout: their own pipeline plus each organization where they may write. */
export function AddToPipeline({ playerId }: { playerId: string }) {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const orgs = useApi((s) => api.myOrgs(s), []);
  const [busy, setBusy] = useState<string | null>(null);
  const scopes: { id: string | null; name: string }[] = [
    { id: null, name: t.pipeline.personal },
    ...(orgs.status === 'success' ? orgs.data.items.filter((o) => WRITE_ROLES.includes(o.myRole) && !o.suspended).map((o) => ({ id: o.id, name: o.name })) : []),
  ];
  const add = async (scope: { id: string | null; name: string }) => {
    setBusy(scope.id ?? 'me');
    try {
      await api.addToPipeline(scope.id, playerId);
      toast.show(fmt(t.pipeline.added, { name: scope.name }), { tone: 'success' });
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  return (
    <section className="stack stack--tight" aria-label={t.pipeline.title} data-testid="add-to-pipeline">
      <ul className="list">
        {scopes.map((s) => (
          <li key={s.id ?? 'me'} className="list__row">
            <span dir="auto">{s.name}</span>
            <Button size="sm" loading={busy === (s.id ?? 'me')} aria-label={fmt(t.pipeline.addTo, { name: s.name })} onClick={() => add(s)}>{t.pipeline.add}</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
