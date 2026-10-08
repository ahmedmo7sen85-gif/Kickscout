'use client';

import { Button, ButtonLink } from '@/components/ui/Button';
import { featureLabel, formatPrice, limitLines, priceFor, trialEndDate, yearlySavingPct } from '@/lib/billing';
import { useI18n } from '@/lib/i18n/provider';
import type { BillingInterval, PlanView } from '@/lib/types';

export interface PlanCardProps {
  plan: PlanView;
  interval: BillingInterval;
  now: Date;
  /** False until the API has a payment provider; buy buttons then explain instead of pretending. */
  paymentsEnabled: boolean;
  signedIn: boolean;
  busy?: boolean;
  salesEmail?: string;
  onChoose?: (plan: PlanView, interval: BillingInterval) => void;
}

/**
 * One plan: price for the chosen period, what it includes, the trial and when the first charge
 * happens, and one clear action. Features that are not built yet say so.
 */
export function PlanCard({ plan, interval, now, paymentsEnabled, signedIn, busy, salesEmail, onChoose }: PlanCardProps) {
  const { t, fmt, pick, locale, formatDate } = useI18n();
  const b = t.billing;
  const chosen = priceFor(plan, interval);
  const per = (i: BillingInterval) => (i === 'year' ? b.perYear : b.perMonth);
  const saving = interval === 'year' && chosen && !chosen.fallback ? yearlySavingPct(plan) : null;
  const priceText = chosen ? formatPrice(chosen.price.amountMinor, chosen.price.currency, locale) : null;

  return (
    <article className="card card--outline plan-card" data-plan={plan.key} aria-labelledby={`plan-${plan.key}`}>
      <header className="stack stack--tight">
        <h2 className="section-title" id={`plan-${plan.key}`}>{pick(plan.name)}</h2>
        <p className="muted small">{pick(plan.description)}</p>
      </header>

      <div className="plan-card__price" data-testid="plan-price">
        {plan.checkout === 'none' ? <strong>{b.free}</strong> : null}
        {plan.checkout === 'contact_sales' ? <strong>{b.custom}</strong> : null}
        {plan.checkout === 'self_serve' && chosen && priceText ? (
          <>
            <strong>{priceText}</strong> <span className="muted">{per(chosen.price.interval)}</span>
            {chosen.fallback ? <p className="muted small">{b.monthlyOnly}</p> : null}
            {saving ? <p className="small"><span className="badge badge--green">{fmt(b.yearlySave, { pct: saving })}</span></p> : null}
          </>
        ) : null}
      </div>

      {plan.checkout === 'self_serve' && chosen && priceText ? (
        <p className="small" data-testid="plan-terms">
          {plan.trialDays > 0
            ? `${fmt(b.trialLine, { days: plan.trialDays, date: formatDate(trialEndDate(now, plan.trialDays).toISOString()) })} ${fmt(b.renewLine, { price: priceText, per: per(chosen.price.interval) })}`
            : fmt(b.chargeLine, { price: priceText, per: per(chosen.price.interval) })}
        </p>
      ) : null}

      <ul className="plan-card__list small">
        {limitLines(plan, t).map((line) => <li key={line}>{line}</li>)}
        {plan.features.map((f) => (
          <li key={f.key}>
            {featureLabel(f.key, t)}
            {f.status === 'coming_soon' ? <> <span className="badge badge--soon">{b.comingSoon}</span></> : null}
          </li>
        ))}
      </ul>

      <div className="plan-card__action">
        {plan.checkout === 'none'
          ? (signedIn ? <p className="muted small">{b.ctaIncluded}</p> : <ButtonLink href="/signup" block>{b.ctaFree}</ButtonLink>)
          : null}
        {plan.checkout === 'contact_sales'
          ? (salesEmail ? <ButtonLink href={`mailto:${salesEmail}?subject=${encodeURIComponent(`KICKSCOUT ${plan.name.en}`)}`} block>{b.ctaContact}</ButtonLink>
            : <p className="muted small">{b.salesSoon}</p>)
          : null}
        {plan.checkout === 'self_serve' && chosen ? (
          !paymentsEnabled ? (
            <>
              <Button block disabled aria-describedby={`off-${plan.key}`}>{plan.trialDays > 0 ? fmt(b.ctaTrial, { days: plan.trialDays }) : b.ctaBuy}</Button>
              <p className="muted small" id={`off-${plan.key}`} data-testid="payments-off">{b.paymentsOffTitle}</p>
            </>
          ) : !signedIn ? (
            <ButtonLink href="/login" block>{b.loginToBuy}</ButtonLink>
          ) : (
            <Button variant="primary" block loading={busy} onClick={() => onChoose?.(plan, chosen.price.interval)}>
              {plan.trialDays > 0 ? fmt(b.ctaTrial, { days: plan.trialDays }) : b.ctaBuy}
            </Button>
          )
        ) : null}
      </div>
    </article>
  );
}
