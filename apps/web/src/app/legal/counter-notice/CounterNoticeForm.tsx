'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { PageHead } from '@/components/PageHead';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Counter-notice for the uploader (or a minor's guardian) of a video removed after a copyright claim. */
export function CounterNoticeForm() {
  const { t } = useI18n();
  return (
    <div className="wrap wrap--narrow page">
      <PageHead title={t.legal.counterTitle} intro={t.legal.counterIntro} kicker={<Link href="/legal/copyright">{t.legal.copyright}</Link>} />
      <AuthGate><Form /></AuthGate>
    </div>
  );
}

function Form() {
  const { t } = useI18n();
  const params = useSearchParams();
  const [video, setVideo] = useState(params.get('video') ?? '');
  const [fullName, setFullName] = useState('');
  const [explanation, setExplanation] = useState('');
  const [goodFaith, setGoodFaith] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const videoId = UUID.exec(video)?.[0] ?? null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!videoId) { setError(t.errors.VIDEO_REQUIRED); return; }
    setBusy(true); setError(null);
    try {
      await api.counterNotice(videoId, { fullName: fullName.trim(), explanation: explanation.trim(), goodFaith: true });
      setSent(true);
    } catch (err) { setError(errorMessage(err, t)); } finally { setBusy(false); }
  };

  if (sent) return <p className="notice notice--accent" role="status">{t.legal.counterSent}</p>;
  return (
    <form className="card stack" onSubmit={submit}>
      <label className="field"><span className="field__label">{t.legal.counterVideo}</span>
        <input className="input" required maxLength={500} value={video} onChange={(e) => setVideo(e.target.value)} dir="ltr" /></label>
      <label className="field"><span className="field__label">{t.legal.fullName}</span>
        <input className="input" required minLength={2} maxLength={120} value={fullName} onChange={(e) => setFullName(e.target.value)} dir="auto" /></label>
      <label className="field"><span className="field__label">{t.legal.explanation}</span>
        <textarea className="input" required minLength={20} maxLength={4000} rows={5} value={explanation} onChange={(e) => setExplanation(e.target.value)} dir="auto" /></label>
      <label className={`check-row${goodFaith ? ' is-checked' : ''}`}>
        <input type="checkbox" required checked={goodFaith} onChange={(e) => setGoodFaith(e.target.checked)} /><span>{t.legal.counterGoodFaith}</span></label>
      {error ? <p className="field__error" role="alert">{error}</p> : null}
      <div><Button type="submit" variant="primary" loading={busy} disabled={!goodFaith}>{t.legal.sendCounter}</Button></div>
    </form>
  );
}
