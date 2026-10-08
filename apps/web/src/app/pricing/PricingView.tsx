'use client';

import { useEffect, useMemo, useState } from 'react';
import { PlanCard } from '@/components/billing/PlanCard';
import { PageHead } from '@/components/PageHead';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/States';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { api, isApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { publicEnv } from '@/lib/env';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { BillingInterval, PlanView } from '@/lib/types';

type Audience = 'players' | 'scouts';
const INTERVALS: BillingInterval[] = ['month', 'year'];

export function PricingView() {
  const { t } = useI18n();
  const b = t.billing;
  const { me, isScout } = useAuth();
  const toast = useToast();
  const plans = useApi((s) => api.plans({ currency: 'USD' }, s), []);
  const [audience, setAudience] = useState<Audience>('players');
  const [interval, setBillingInterval] = useState<BillingInterval>('month');
  const [coupon, setCoupon] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [paymentsOff, setPaymentsOff] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const now = useMemo(() => new Date(), []);

  useEffect(() => {
    if (isScout) setAudience('scouts');
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('checkout') === 'cancelled') setCancelled(true);
  }, [isScout]);

  const choose = async (plan: PlanView, chosen: BillingInterval) => {
    setBusy(plan.key);
    try {
      const code = coupon.trim();
      const r = await api.checkout({ planKey: plan.key, interval: chosen, currency: 'USD', ...(code ? { couponCode: code } : {}) });
      toast.show(b.redirecting);
      // The plan changes only after the payment provider confirms payment to our server.
      window.location.assign(r.url);
    } catch (e) {
      if (isApiError(e) && e.isBillingOff) setPaymentsOff(true);
      else toast.show(errorMessage(e, t), { tone: 'error' });
      setBusy(null);
    }
  };

  const enabled = plans.status === 'success' && plans.data.paymentsEnabled && !paymentsOff;
  const visible = plans.status === 'success'
    ? plans.data.items.filter((p) => (audience === 'players' ? p.audience === 'player' : p.audience !== 'player'))
    : [];
  const minor = me ? me.ageGroup !== 'adult' : false;

  return (
    <div className="wrap page">
      <PageHead title={b.pricingTitle} intro={b.pricingIntro} />
      <div className="stack">
        {cancelled ? <p className="notice small" role="status">{b.checkoutCancelled}</p> : null}
        {plans.status === 'success' && !enabled ? (
          <div className="notice notice--warn" role="status" data-testid="payments-off-banner">
            <strong>{b.paymentsOffTitle}</strong>
            <p>{b.paymentsOffText}</p>
          </div>
        ) : null}
        <Tabs<Audience> label={b.audienceLabel} active={audience} onChange={setAudience} panelId="plans-panel"
          items={[{ id: 'players', label: b.tabPlayers }, { id: 'scouts', label: b.tabScouts }]} />
        <fieldset className="chips" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">{b.intervalLabel}</legend>
          {INTERVALS.map((i) => (
            <label key={i} className={`chip chip--sm${interval === i ? ' is-active' : ''}`}>
              <input type="radio" className="sr-only" name="interval" checked={interval === i} onChange={() => setBillingInterval(i)} />
              {i === 'month' ? b.monthly : b.yearly}
            </label>
          ))}
        </fieldset>
        {minor ? <p className="notice notice--warn small">{b.minorNote}</p> : null}
        {audience === 'scouts' && me && !isScout ? <p className="notice small">{b.scoutNote}</p> : null}

        <div id="plans-panel" role="tabpanel">
          {plans.status === 'loading' ? <SkeletonList rows={3} label={t.common.loading} /> : null}
          {plans.status === 'error' ? <ErrorState error={plans.error} onRetry={plans.retry} /> : null}
          {plans.status === 'success' ? (
            <div className="grid-plans">
              {visible.map((p) => (
                <PlanCard key={p.key} plan={p} interval={interval} now={now} paymentsEnabled={enabled} signedIn={Boolean(me)}
                  busy={busy === p.key} salesEmail={publicEnv.salesEmail || undefined} onChoose={choose} />
              ))}
            </div>
          ) : null}
        </div>

        {enabled && me ? (
          <label className="field">
            <span className="field__label">{b.couponLabel}</span>
            <input className="input" value={coupon} maxLength={40} autoComplete="off" spellCheck={false} onChange={(e) => setCoupon(e.target.value)} />
            <span className="field__hint">{b.couponHint}</span>
          </label>
        ) : null}
      </div>
    </div>
  );
}
