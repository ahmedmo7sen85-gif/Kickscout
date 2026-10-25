import { IN_PLAY, type Match, type MatchStatus } from './types.js';

/**
 * Match alerts are derived from verified state changes between two observations of the same match
 * (a stored snapshot and the provider's current answer). Nothing is inferred from the clock except
 * "starting soon", which is about the scheduled kickoff, not about play.
 */
export const ALERT_CATEGORIES = ['starting_soon', 'kickoff', 'goal', 'halftime', 'final_result', 'lineups'] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export interface MatchSnapshot {
  status: MatchStatus;
  home: number | null;
  away: number | null;
  kickoff: string;
  lineupsConfirmed: boolean;
}

export interface MatchAlert {
  category: AlertCategory;
  /** Stable per match and event; one delivery per (key, subscription), however often the job runs. */
  key: string;
  match: Match;
}

export const STARTING_SOON_MINUTES = 30;

export function snapshotOf(m: Match, lineupsConfirmed: boolean): MatchSnapshot {
  return { status: m.status, home: m.score.home, away: m.score.away, kickoff: m.kickoff, lineupsConfirmed };
}

export function detectAlerts(prev: MatchSnapshot | null, next: Match, now: Date, lineupsConfirmed = false): MatchAlert[] {
  const out: MatchAlert[] = [];
  const base = `${next.provider}:${next.id}`;
  const add = (category: AlertCategory, suffix: string) => out.push({ category, key: `${base}:${category}:${suffix}`, match: next });

  const untilKickoff = Date.parse(next.kickoff) - now.getTime();
  if (next.status === 'scheduled' && untilKickoff > 0 && untilKickoff <= STARTING_SOON_MINUTES * 60_000) add('starting_soon', next.kickoff);
  if (lineupsConfirmed && (!prev || !prev.lineupsConfirmed) && (next.status === 'scheduled' || IN_PLAY.includes(next.status))) add('lineups', 'confirmed');

  // Everything below needs two observations: a first sighting is never reported as news.
  if (!prev) return out;

  if (prev.status === 'scheduled' && next.status === 'live') add('kickoff', 'ko');
  const before = prev.home !== null && prev.away !== null ? prev.home + prev.away : null;
  const after = next.score.home !== null && next.score.away !== null ? next.score.home + next.score.away : null;
  const playing = IN_PLAY.includes(next.status) || next.status === 'finished';
  if (before !== null && after !== null && after > before && playing && prev.status !== 'finished') add('goal', `${next.score.home}-${next.score.away}`);
  if (prev.status === 'live' && next.status === 'halftime') add('halftime', 'ht');
  if (next.status === 'finished' && (IN_PLAY.includes(prev.status) || prev.status === 'scheduled' || prev.status === 'suspended')) add('final_result', 'ft');
  return out;
}

type Locale = 'en' | 'ar';

const score = (m: Match) => `${m.home.name} ${m.score.home ?? '-'}–${m.score.away ?? '-'} ${m.away.name}`;
const fixture = (m: Match) => `${m.home.name} v ${m.away.name}`;

/** Notification text. Kept short: push services truncate long bodies, and a lock screen is small. */
export function alertMessage(a: MatchAlert, locale: Locale = 'en'): { title: string; body: string } {
  const m = a.match;
  const ar = locale === 'ar';
  switch (a.category) {
    case 'starting_soon':
      return { title: ar ? 'تبدأ المباراة قريبًا' : 'Starting soon', body: `${fixture(m)} · ${m.competition.name}` };
    case 'kickoff':
      return { title: ar ? 'انطلقت المباراة' : 'Kick-off', body: fixture(m) };
    case 'goal':
      return { title: ar ? 'هدف!' : 'Goal!', body: score(m) };
    case 'halftime':
      return { title: ar ? 'نهاية الشوط الأول' : 'Half-time', body: score(m) };
    case 'final_result':
      return { title: ar ? 'النتيجة النهائية' : 'Full-time', body: score(m) };
    case 'lineups':
      return { title: ar ? 'التشكيلة الرسمية' : 'Line-ups are out', body: fixture(m) };
  }
}

/**
 * How long a provider answer stays fresh in the shared cache, by what it holds. Live data is
 * refreshed often (SportScore itself caches for 60 s); finished results and standings rarely.
 */
export function freshForSeconds(kind: 'matches' | 'match' | 'team' | 'standings' | 'competitions', data: { status?: MatchStatus; matches?: { status: MatchStatus }[]; day?: string; today?: string }): number {
  const live = (s: MatchStatus | undefined) => s !== undefined && IN_PLAY.includes(s);
  switch (kind) {
    case 'matches': {
      if (data.matches?.some((m) => live(m.status))) return 60;
      if (data.day && data.today && data.day < data.today) return 6 * 3600;
      if (data.day && data.today && data.day > data.today) return 30 * 60;
      return 5 * 60;
    }
    case 'match':
      if (live(data.status)) return 60;
      if (data.status === 'finished') return 24 * 3600;
      return 10 * 60;
    case 'team':
      return 15 * 60;
    case 'standings':
      return 30 * 60;
    case 'competitions':
      return 24 * 3600;
  }
}
