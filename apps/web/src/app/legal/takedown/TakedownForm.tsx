'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { PageHead } from '@/components/PageHead';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';

/** Public copyright takedown request. No account needed; the API rate-limits and validates it. */
export function TakedownForm() {
  const { t, fmt } = useI18n();
  const [claimantName, setName] = useState('');
  const [email, setEmail] = useState('');
  const [video, setVideo] = useState('');
  const [description, setDescription] = useState('');
  const [goodFaith, setGoodFaith] = useState(false);
  const [accurate, setAccurate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!goodFaith || !accurate) return;
    setBusy(true); setError(null);
    try {
      const r = await api.copyrightTakedown({ claimantName: claimantName.trim(), email: email.trim(), video: video.trim(), description: description.trim(), goodFaith: true, accurate: true });
      setSent(r.claimId);
    } catch (err) { setError(errorMessage(err, t)); } finally { setBusy(false); }
  };

  return (
    <div className="wrap wrap--narrow page">
      <PageHead title={t.legal.takedownTitle} intro={t.legal.takedownIntro} kicker={<Link href="/legal/copyright">{t.legal.copyright}</Link>} />
      {sent ? <p className="notice notice--accent" role="status">{fmt(t.legal.takedownSent, { id: sent })}</p> : (
        <form className="card stack" onSubmit={submit}>
          <label className="field"><span className="field__label">{t.legal.claimantName}</span>
            <input className="input" required minLength={2} maxLength={120} value={claimantName} onChange={(e) => setName(e.target.value)} dir="auto" /></label>
          <label className="field"><span className="field__label">{t.legal.claimantEmail}</span>
            <input className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" /></label>
          <label className="field"><span className="field__label">{t.legal.videoLink}</span>
            <input className="input" required maxLength={500} value={video} onChange={(e) => setVideo(e.target.value)} dir="ltr" placeholder="https://…/v/…" /></label>
          <label className="field"><span className="field__label">{t.legal.workDescription}</span>
            <textarea className="input" required minLength={20} maxLength={4000} rows={5} value={description} onChange={(e) => setDescription(e.target.value)} dir="auto" />
            <span className="field__hint">{t.legal.workDescriptionHint}</span></label>
          <label className={`check-row${goodFaith ? ' is-checked' : ''}`}>
            <input type="checkbox" required checked={goodFaith} onChange={(e) => setGoodFaith(e.target.checked)} /><span>{t.legal.goodFaith}</span></label>
          <label className={`check-row${accurate ? ' is-checked' : ''}`}>
            <input type="checkbox" required checked={accurate} onChange={(e) => setAccurate(e.target.checked)} /><span>{t.legal.accurate}</span></label>
          {error ? <p className="field__error" role="alert">{error}</p> : null}
          <div><Button type="submit" variant="primary" loading={busy} disabled={!goodFaith || !accurate}>{t.legal.sendTakedown}</Button></div>
        </form>
      )}
    </div>
  );
}
