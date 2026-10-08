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
  'feed.trending': 'coming_soon',
  'feed.challenges': 'coming_soon',
  'feed.nearby_talent': 'coming_soon',
  'analysis.video_quality': 'requires_model_integration',
  'analysis.player_tracking': 'requires_model_integration',
  'analysis.events': 'requires_model_integration',
  'analysis.skill_scores': 'prototype',
  'analysis.movement': 'requires_model_integration',
  'analysis.tactical': 'requires_model_integration',
  'analysis.decision_making': 'requires_model_integration',
  'intelligence.player_dna': 'prototype',
  'intelligence.scouting_report': 'requires_model_integration',
  'integrity.duplicates': 'coming_soon',
  'integrity.manipulation': 'coming_soon',
  'challenges': 'coming_soon',
  'scout.dashboard': 'coming_soon',
  'billing.paid_plans': 'coming_soon',
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
