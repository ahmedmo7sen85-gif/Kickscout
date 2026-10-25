import type { MatchEventType, MatchStatus } from './types.js';

/**
 * SportScore sends a coarse `status` plus a human `status_text`. Seen in responses on 2026-10-25:
 * ("finished", "Finished"), ("upcoming", "Delayed"). Anything we cannot place with certainty is
 * `unknown`, which the UI never presents as live.
 */
export function sportscoreStatus(status: unknown, text: unknown): MatchStatus {
  const s = typeof status === 'string' ? status.trim().toLowerCase() : '';
  const t = typeof text === 'string' ? text.trim().toLowerCase() : '';
  if (/postpon/.test(t) || s === 'postponed') return 'postponed';
  if (/cancel/.test(t) || s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (/abandon/.test(t) || s === 'abandoned') return 'abandoned';
  if (/suspend|interrupt/.test(t) || s === 'suspended' || s === 'interrupted') return 'suspended';
  if (s === 'finished' || s === 'ended' || s === 'ft' || s === 'aet' || s === 'ap') return 'finished';
  if (/half.?time|^ht$|break/.test(t) || s === 'halftime' || s === 'ht') return 'halftime';
  if (s === 'live' || s === 'inprogress' || s === 'in_progress' || s === 'playing') return 'live';
  if (s === 'upcoming' || s === 'scheduled' || s === 'notstarted' || s === 'not_started') return 'scheduled';
  return 'unknown';
}

/** football-data.org v4 match statuses. */
export function footballDataStatus(status: unknown): MatchStatus {
  switch (typeof status === 'string' ? status : '') {
    case 'SCHEDULED':
    case 'TIMED':
      return 'scheduled';
    case 'IN_PLAY':
    case 'LIVE':
    case 'EXTRA_TIME':
    case 'PENALTY_SHOOTOUT':
      return 'live';
    case 'PAUSED':
      return 'halftime';
    case 'FINISHED':
    case 'AWARDED':
      return 'finished';
    case 'POSTPONED':
      return 'postponed';
    case 'SUSPENDED':
      return 'suspended';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

export function sportscoreEventType(label: string, typeId: unknown, isGoal: unknown, isCard: unknown): MatchEventType {
  const l = label.toLowerCase();
  if (/own goal/.test(l)) return 'own_goal';
  if (/missed penalty|penalty missed/.test(l)) return 'missed_penalty';
  if (/penalty/.test(l) && (isGoal === true || /goal/.test(l))) return 'penalty_goal';
  if (isGoal === true || typeId === 1 || /^goal/.test(l)) return 'goal';
  if (/second yellow|yellow.?red/.test(l)) return 'second_yellow';
  if (/red card/.test(l)) return 'red_card';
  if (/yellow/.test(l) || (isCard === true && typeId === 3)) return 'yellow_card';
  if (/substitut/.test(l)) return 'substitution';
  if (/\bvar\b/.test(l)) return 'var';
  return 'other';
}
