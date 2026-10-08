'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ORG_TYPES } from '@fp/domain';
import { AuthGate } from '@/components/AuthGate';
import { PageHead } from '@/components/PageHead';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { OrgType } from '@/lib/types';

export function OrgNewView() {
  const { t } = useI18n();
  return (
    <div className="wrap wrap--mid page">
      <PageHead title={t.org.newTitle} intro={t.org.newIntro} />
      <AuthGate><OrgForm /><MyOrgs /></AuthGate>
    </div>
  );
}

export function OrgForm({ onCreated }: { onCreated?: (id: string) => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [type, setType] = useState<OrgType>('academy');
  const [country, setCountry] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cc = country.trim().toUpperCase();
    setBusy(true);
    try {
      const org = await api.createOrg({ name: name.trim(), type, countryCode: /^[A-Z]{2}$/.test(cc) ? cc : undefined });
      toast.show(t.org.created, { tone: 'success' });
      if (onCreated) onCreated(org.id); else router.push(`/org/${org.id}`);
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <form className="card" onSubmit={submit} aria-label={t.org.newTitle} data-testid="org-form">
      <label className="field"><span className="field__label">{t.org.name}</span>
        <input className="input" required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} dir="auto" /></label>
      <label className="field"><span className="field__label">{t.org.type}</span>
        <select className="input" value={type} onChange={(e) => setType(e.target.value as OrgType)}>
          {ORG_TYPES.map((k) => <option key={k} value={k}>{t.orgTypes[k]}</option>)}
        </select></label>
      <label className="field"><span className="field__label">{t.org.country}</span>
        <input className="input" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value)} />
        <span className="field__hint">{t.org.countryHint}</span></label>
      <p className="muted small">{t.org.adultsOnly}</p>
      <div><Button type="submit" variant="primary" loading={busy} disabled={name.trim().length < 2}>{t.org.create}</Button></div>
    </form>
  );
}

function MyOrgs() {
  const { t } = useI18n();
  const mine = useApi((s) => api.myOrgs(s), []);
  return (
    <section className="card" aria-labelledby="my-orgs">
      <h2 className="section-title" id="my-orgs">{t.org.mine}</h2>
      {mine.status === 'loading' ? <SkeletonList rows={2} label={t.common.loading} /> : null}
      {mine.status === 'success' && !mine.data.items.length ? <p className="muted small">{t.org.mineEmpty}</p> : null}
      {mine.status === 'success' && mine.data.items.length ? (
        <ul className="list">
          {mine.data.items.map((o) => (
            <li key={o.id} className="list__row">
              <Link className="link" href={`/org/${o.id}`} dir="auto">{o.name}</Link>
              <span className="badge badge--outline">{t.orgRoles[o.myRole]}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
