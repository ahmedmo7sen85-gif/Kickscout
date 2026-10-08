'use client';

import { Button, ButtonLink } from '@/components/ui/Button';
import { formatPrice } from '@/lib/billing';
import { useI18n } from '@/lib/i18n/provider';
import type { EntitlementsView, SubscriptionView } from '@/lib/types';

/**
 * The current plan in Settings: status, the next date that matters (trial end, renewal or end of a
 * cancelled plan) with the amount, the limits in effect, and one button to manage or cancel.
 */
export function BillingSummary({ data, roles, paymentsOff, busy, confirming, onManage, onRefresh }: {
  data: EntitlementsView;
  roles: readonly string[];
  /** The API said payments are not enabled (503 BILLING_NOT_CONFIGURED). */
  paymentsOff?: boolean;
  busy?: boolean;
  /** Back from checkout: waiting for the provider's confirmation; never shown as success. */
  confirming?: boolean;
  onManage?: () => void;
  onRefresh?: () => void;
}) {
  const { t, fmt, pick, locale, formatDate } = useI18n();
  const b = t.billing;
  const off = paymentsOff || !data.paymentsEnabled;
  const u = data.usage;
  const l = data.limits;
  const isScout = roles.includes('scout');
  const isPlayer = roles.includes('player');

  const line = (s: SubscriptionView) => {
    const price = s.amountMinor !== null && s.currency ? formatPrice(s.amountMinor, s.currency, locale) : null;
    if (s.status === 'trialing' && s.trialEnd) return fmt(b.trialEnds, { date: formatDate(s.trialEnd), price: price ?? '' });
    if (s.cancelAtPeriodEnd && s.currentPeriodEnd) return fmt(b.cancelsOn, { date: formatDate(s.currentPeriodEnd) });
    if (s.status === 'past_due') return b.pastDueText;
    if (s.currentPeriodEnd && price) return fmt(b.renews, { date: formatDate(s.currentPeriodEnd), price });
    return null;
  };

  return (
    <div className="stack" data-testid="billing-summary">
      {confirming && !data.subscriptions.some((s) => s.grantsAccess) ? (
        <div className="notice notice--accent small" role="status">
          <p>{b.confirming}</p>
          {onRefresh ? <div><Button size="sm" onClick={onRefresh}>{b.refresh}</Button></div> : null}
        </div>
      ) : null}

      <div>
        <h3 className="field__label">{b.currentPlans}</h3>
        {data.subscriptions.length === 0 ? <p data-testid="billing-free"><strong>{b.freePlan}</strong></p> : (
          <ul className="list">
            {data.subscriptions.map((s) => (
              <li key={`${s.planKey}-${s.status}`} className="stack stack--tight" data-testid="billing-subscription">
                <span className="row">
                  <strong>{pick(s.planName)}</strong>
                  <span className={`badge ${s.status === 'past_due' || s.status === 'unpaid' ? 'badge--warn' : s.grantsAccess ? 'badge--green' : 'badge--outline'}`}>
                    {b[`status_${s.status}`]}
                  </span>
                </span>
                {line(s) ? <span className="small">{line(s)}</span> : null}
                {s.paidByOther ? <span className="muted small">{b.paidByOther}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="field__label">{b.usageTitle}</h3>
        <ul className="small plan-card__list">
          {isPlayer ? (
            <>
              <li>{fmt(b.usageVideos, { used: u.activeVideos, max: l.maxActiveVideos })}</li>
              <li>{fmt(b.usageClip, { n: l.maxVideoSeconds })}</li>
            </>
          ) : null}
          {isScout ? (
            <>
              <li>{l.scoutSearchesPerMonth === null ? fmt(b.usageSearchesUnlimited, { used: u.scoutSearchesThisMonth }) : fmt(b.usageSearches, { used: u.scoutSearchesThisMonth, max: l.scoutSearchesPerMonth })}</li>
              <li>{l.shortlistSlots === null ? fmt(b.usageSlotsUnlimited, { used: u.shortlistSlotsUsed }) : fmt(b.usageSlots, { used: u.shortlistSlotsUsed, max: l.shortlistSlots })}</li>
            </>
          ) : null}
        </ul>
      </div>

      <div className="row">
        {data.hasBillingAccount ? (
          <Button variant="primary" onClick={onManage} loading={busy} disabled={off} aria-describedby="billing-manage-hint">{b.manage}</Button>
        ) : null}
        <ButtonLink href="/pricing">{b.seePlans}</ButtonLink>
      </div>
      {data.hasBillingAccount ? <p className="muted small" id="billing-manage-hint">{b.manageHint}</p> : null}
      {off ? <p className="notice notice--warn small" role="status" data-testid="billing-off">{b.paymentsOffTitle}</p> : null}
    </div>
  );
}
