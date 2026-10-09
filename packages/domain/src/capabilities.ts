/**
 * Every user-facing capability declares its real status. The UI renders the label; nothing
 * that is not backed by a working implementation may be shown without one.
 */

export type CapabilityStatus = 'live' | 'prototype' | 'coming_soon' | 'requires_model_integration';

export const STATUS_LABELS: Record<Exclude<CapabilityStatus, 'live'>, { en: string; ar: string }> = {
  prototype: { en: 'Prototype', ar: 'نموذج أولي' },
  coming_soon: { en: 'Coming Soon', ar: 'قريبًا' },
  requires_model_integration: { en: 'Requires Model Integration', ar: 'يتطلب دمج النموذج' },
};

export const CAPABILITIES = {
  'feed.for_you': 'live',
  'feed.new_talent': 'live',
  'feed.following': 'live',
  'feed.trending': 'live',
  'feed.challenges': 'live',
  'feed.nearby_talent': 'coming_soon',
  'ai.skill_tags': 'live',
  'ai.moderation': 'live',
  'search.keyword': 'live',
  // Built (AI parser with a rule-based fallback) but off until NL_SCOUT_SEARCH=on.
  'search.natural_language': 'prototype',
  // For You personalisation with user controls; off until FOR_YOU_PERSONALIZATION=on.
  'feed.personalization': 'prototype',
  'talent_radar': 'live',
  'challenges': 'live',
  'scout.shortlists': 'live',
  'scout.notes': 'live',
  'scout.contact': 'live',
  'scout.compare': 'coming_soon',
  'messaging.direct': 'coming_soon',
  'auth.apple': 'coming_soon',
  // Built against Stripe test mode only; payments are off until STRIPE_* keys are set.
  'billing.paid_plans': 'prototype',
} as const satisfies Record<string, CapabilityStatus>;

export type CapabilityKey = keyof typeof CAPABILITIES;

export function capability(key: CapabilityKey): {
  key: CapabilityKey;
  status: CapabilityStatus;
  label: { en: string; ar: string } | null;
} {
  const status: CapabilityStatus = CAPABILITIES[key];
  return { key, status, label: status === 'live' ? null : STATUS_LABELS[status] };
}
