/**
 * Talent discovery and popularity are separate numbers by construction. Popularity is never an
 * input to football scores; engagement enters discovery only as a small, capped term.
 */

export interface DiscoveryInputs {
  /** Position index or best available index, 0..100, or null when not assessed. */
  performance: number | null;
  /** Confidence of that performance score, 0..1. */
  confidence: number;
  /** Recent change in score points, positive or negative; null when unknown. */
  trend: number | null;
  /** Share of recent clips with readiness >= 0.6, 0..1. */
  videoQuality: number;
  /** Engagement quality from the anti-gaming pipeline, 0..1 (not raw followers or views). */
  engagement: number;
}

export const DISCOVERY_VERSION = 'discovery-0.1.0';
const ENGAGEMENT_WEIGHT = 0.1;

export function discoveryScore(i: DiscoveryInputs): number | null {
  if (i.performance === null || i.confidence < 0.3) return null;
  const trend = i.trend === null ? 0.5 : Math.min(1, Math.max(0, 0.5 + i.trend / 20));
  const evidence = 0.6 * (i.performance / 100) * i.confidence + 0.15 * trend + 0.15 * i.videoQuality;
  const total = evidence / 0.9 * (1 - ENGAGEMENT_WEIGHT) + ENGAGEMENT_WEIGHT * Math.min(1, Math.max(0, i.engagement));
  return Math.round(total * 1000) / 10;
}

/** Popularity on a log scale so a large following does not dwarf everything else. */
export function popularityScore(followers: number, engagedViews30d: number): number {
  const f = Math.log10(1 + Math.max(0, followers)) / 7; // ~10M followers saturates
  const v = Math.log10(1 + Math.max(0, engagedViews30d)) / 8;
  return Math.round(Math.min(1, 0.5 * f + 0.5 * v) * 1000) / 10;
}
