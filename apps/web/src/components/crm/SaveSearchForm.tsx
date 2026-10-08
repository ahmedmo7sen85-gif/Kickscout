'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { OrgRole, ScoutSearchQuery } from '@/lib/types';

const WRITE_ROLES: readonly OrgRole[] = ['owner', 'admin', 'scout'];

/** Saves the current scout-search filters, for the scout alone or for one of their organizations. */
export function SaveSearchForm({ filters }: { filters: ScoutSearchQuery }) {
  const { t } = useI18n();
  const toast = useToast();
  const orgs = useApi((s) => api.myOrgs(s), []);
  const writable = orgs.status === 'success' ? orgs.data.items.filter((o) => WRITE_ROLES.includes(o.myRole) && !o.suspended) : [];
  const [name, setName] = useState('');
  const [scope, setScope] = useState('');
  const [alerts, setAlerts] = useState(true);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const { cursor: _c, limit: _l, ...rest } = filters;
      await api.createSavedSearch(scope || null, { name: name.trim(), filters: rest, alerts });
      setName('');
      toast.show(t.savedSearches.saved, { tone: 'success' });
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <form className="card stack stack--tight" onSubmit={submit} aria-label={t.savedSearches.save} data-testid="save-search">
      <h2 className="section-title" style={{ fontSize: '1.1rem' }}>{t.savedSearches.save}</h2>
      <label className="field"><span className="field__label">{t.savedSearches.name}</span>
        <input className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} dir="auto" /></label>
      {writable.length ? (
        <label className="field"><span className="field__label">{t.pipeline.scope}</span>
          <select className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">{t.pipeline.personal}</option>
            {writable.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select></label>
      ) : null}
      <label className="check"><input type="checkbox" role="switch" aria-checked={alerts} checked={alerts} onChange={(e) => setAlerts(e.target.checked)} />{t.savedSearches.alerts}</label>
      <div className="row">
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!name.trim()}>{t.savedSearches.save}</Button>
        <Link className="link small" href="/scout/pipeline">{t.savedSearches.manage}</Link>
      </div>
    </form>
  );
}
