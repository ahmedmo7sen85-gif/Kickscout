'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { REPORT_REASONS } from '@/lib/constants';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import type { ReportReason, ReportRequest } from '@/lib/types';

export function ReportSheet({ targetKind, targetId, open, onClose }:
  { targetKind: ReportRequest['targetKind']; targetId: string; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);

  const submit = async () => {
    if (!reason) return;
    setSending(true);
    try {
      await api.report({ targetKind, targetId, reason, details: details.trim() || undefined });
      toast.show(t.feed.reportThanks, { tone: 'success' });
      setReason(null);
      setDetails('');
      onClose();
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={t.feed.reportTitle}
      footer={<Button variant="danger" block disabled={!reason} loading={sending} onClick={submit}>{t.feed.reportSubmit}</Button>}>
      <fieldset className="radio-list">
        <legend className="muted small">{t.feed.reportIntro}</legend>
        {REPORT_REASONS.map((r) => (
          <label key={r} className={`radio-row${reason === r ? ' is-checked' : ''}`}>
            <input type="radio" name={`reason-${targetId}`} value={r} checked={reason === r} onChange={() => setReason(r)} />
            {t.reportReasons[r]}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="field__label">{t.feed.reportDetails}</span>
        <textarea className="input" rows={3} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} dir="auto" />
      </label>
    </Sheet>
  );
}
