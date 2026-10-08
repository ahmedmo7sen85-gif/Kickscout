'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { PageHead } from '@/components/PageHead';
import { PipelineBoard } from '@/components/crm/PipelineBoard';
import { SavedSearchList } from '@/components/crm/SavedSearchList';
import { ErrorState } from '@/components/ui/States';
import { SkeletonList } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { CrmEntryView, CrmStage, OrgRole, SavedSearchView } from '@/lib/types';

const WRITE_ROLES: readonly OrgRole[] = ['owner', 'admin', 'scout'];

/** /scout/pipeline?org=<id>: the personal pipeline (scouts) or an organization's (any member). */
export function PipelineView() {
  const { t } = useI18n();
  return (
    <>
      <PageHead title={t.pipeline.title} intro={t.pipeline.intro} />
      <AuthGate><Pipeline /></AuthGate>
    </>
  );
}

function Pipeline() {
  const { t, fmt } = useI18n();
  const { isScout } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const orgs = useApi((s) => api.myOrgs(s), []);
  const orgItems = orgs.status === 'success' ? orgs.data.items : [];
  const requested = params.get('org');
  // Personal scope needs the scout role; otherwise fall back to the first organization.
  const orgId = requested ?? (isScout ? null : orgItems[0]?.id ?? null);
  const org = orgItems.find((o) => o.id === orgId) ?? null;
  const ready = orgId ? org !== null : isScout;
  const canWrite = isScout && (orgId ? !!org && WRITE_ROLES.includes(org.myRole) : true);

  const board = useApi((s) => api.pipeline(orgId, {}, s), [orgId], { enabled: ready });
  const searches = useApi((s) => api.savedSearches(orgId, s), [orgId], { enabled: ready });
  const [busy, setBusy] = useState<string | null>(null);

  const setScope = (v: string) => {
    const q = new URLSearchParams(params.toString());
    if (v) q.set('org', v); else q.delete('org');
    router.replace(`${pathname}${q.size ? `?${q}` : ''}`);
  };

  const move = async (e: CrmEntryView, stage: CrmStage, message?: string) => {
    setBusy(e.id);
    try {
      const updated = await api.moveCrmEntry(orgId, e.id, { stage, ...(message ? { message } : {}) });
      board.setData((d) => ({ ...d, items: d.items.map((x) => (x.id === updated.id ? updated : x)) }));
      toast.show(fmt(t.pipeline.moved, { stage: t.crmStages[stage] }), { tone: 'success' });
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  const toggle = async (s: SavedSearchView, on: boolean) => {
    setBusy(s.id);
    try {
      const updated = await api.updateSavedSearch(orgId, s.id, { alerts: on });
      searches.setData((d) => ({ ...d, items: d.items.map((x) => (x.id === updated.id ? updated : x)) }));
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  const remove = async (s: SavedSearchView) => {
    setBusy(s.id);
    try {
      await api.deleteSavedSearch(orgId, s.id);
      searches.setData((d) => ({ ...d, items: d.items.filter((x) => x.id !== s.id) }));
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(null); }
  };

  if (orgs.status === 'loading') return <SkeletonList rows={3} label={t.common.loading} />;
  if (orgs.status === 'error') return <ErrorState error={orgs.error} onRetry={orgs.retry} />;
  if (!isScout && !orgItems.length) return <p className="card muted">{t.scout.notScoutText}</p>;

  return (
    <div className="stack">
      <label className="field" style={{ maxWidth: 360 }}>
        <span className="field__label">{t.pipeline.scope}</span>
        <select className="input" value={orgId ?? ''} onChange={(e) => setScope(e.target.value)}>
          {isScout ? <option value="">{t.pipeline.personal}</option> : null}
          {orgItems.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      {!ready ? <p className="card muted">{t.org.notFound}</p> : null}
      {ready && !canWrite ? <p className="muted small" role="status">{t.pipeline.readOnly}</p> : null}
      {ready && board.status === 'loading' ? <SkeletonList rows={4} label={t.common.loading} /> : null}
      {ready && board.status === 'error' ? <ErrorState error={board.error} onRetry={board.retry} /> : null}
      {ready && board.status === 'success' ? (
        <>
          {!board.data.items.length ? <p className="muted small">{t.pipeline.addHint}</p> : null}
          <PipelineBoard items={board.data.items} canWrite={canWrite} busyId={busy} onMove={move} />
        </>
      ) : null}
      {ready ? (
        <section className="card" aria-labelledby="saved-searches-title">
          <h2 className="section-title" id="saved-searches-title">{t.savedSearches.title}</h2>
          <p className="muted small">{t.savedSearches.alertsHint}</p>
          {searches.status === 'loading' ? <SkeletonList rows={2} label={t.common.loading} /> : null}
          {searches.status === 'error' ? <ErrorState error={searches.error} onRetry={searches.retry} /> : null}
          {searches.status === 'success' ? (
            <SavedSearchList items={searches.data.items} canWrite={canWrite} busyId={busy} onToggle={toggle} onDelete={remove} />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
