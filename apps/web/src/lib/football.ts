/**
 * Pure helpers for the football pages: time-zone aware formatting, day navigation, grouping, and
 * the device-local favourites used before someone has an account. No React, no network.
 */
import type { CompetitionRef, MatchStatus, MatchView, TeamRef } from './types';

export const IN_PLAY: readonly MatchStatus[] = ['live', 'halftime'];
export const isInPlay = (s: MatchStatus) => IN_PLAY.includes(s);

/** The browser's zone, or UTC when it cannot be read. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Calendar day (YYYY-MM-DD) of an instant in a zone. */
export function dayInZone(at: Date, tz: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const isDay = (v: string | null | undefined): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)));

/** Kick-off time (hours and minutes) in the chosen zone and UI language. */
export function kickoffTime(iso: string, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function kickoffDateTime(iso: string, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** A long, readable label for a calendar day (the day itself, not "today"). */
export function dayLabel(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${day}T12:00:00Z`));
}

/** "2 minutes ago" in the UI language. */
export function relativeTime(iso: string, now: Date, locale: string): string {
  const secs = Math.round((Date.parse(iso) - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(secs);
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(secs / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(secs / 3600), 'hour');
  return rtf.format(Math.round(secs / 86_400), 'day');
}

/** Score text, or null before kickoff (never "0–0" for a match that has not started). */
export function scoreText(m: Pick<MatchView, 'score' | 'status'>): string | null {
  if (m.score.home === null || m.score.away === null) return null;
  if (m.status === 'scheduled' || m.status === 'postponed' || m.status === 'cancelled') return null;
  return `${m.score.home}–${m.score.away}`;
}

export interface CompetitionGroup {
  key: string;
  competition: CompetitionRef;
  matches: MatchView[];
}

/** Groups by competition, keeping each group's matches in kickoff order and the first group first. */
export function groupByCompetition(matches: MatchView[]): CompetitionGroup[] {
  const groups = new Map<string, CompetitionGroup>();
  for (const m of matches) {
    const key = m.competition.id ?? `name:${m.competition.name}`;
    const g = groups.get(key) ?? { key, competition: m.competition, matches: [] };
    g.matches.push(m);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function involves(m: MatchView, teamIds: Set<string>, competitionIds: Set<string>): boolean {
  return teamIds.has(m.home.id) || teamIds.has(m.away.id) || (m.competition.id !== null && competitionIds.has(m.competition.id));
}

// ---------------------------------------------------------------- device-local favourites (before sign-up)
export interface LocalFavorites {
  provider: string | null;
  teams: TeamRef[];
  competitions: CompetitionRef[];
}

const KEY = 'ks_football_favorites';
export const EMPTY_LOCAL: LocalFavorites = { provider: null, teams: [], competitions: [] };
const MAX_LOCAL = 50;

/** Reads favourites saved on this device. Storage can be missing or blocked; that is an empty list. */
export function readLocalFavorites(storage: Pick<Storage, 'getItem'> | null): LocalFavorites {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return EMPTY_LOCAL;
    const v = JSON.parse(raw) as Partial<LocalFavorites>;
    const okTeam = (t: unknown): t is TeamRef => typeof (t as TeamRef)?.id === 'string' && typeof (t as TeamRef)?.name === 'string';
    const okComp = (c: unknown): c is CompetitionRef => typeof (c as CompetitionRef)?.id === 'string' && typeof (c as CompetitionRef)?.name === 'string';
    return {
      provider: typeof v.provider === 'string' ? v.provider : null,
      teams: Array.isArray(v.teams) ? v.teams.filter(okTeam).slice(0, MAX_LOCAL) : [],
      competitions: Array.isArray(v.competitions) ? v.competitions.filter(okComp).slice(0, MAX_LOCAL) : [],
    };
  } catch {
    return EMPTY_LOCAL;
  }
}

export function writeLocalFavorites(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, v: LocalFavorites) {
  try {
    if (!v.teams.length && !v.competitions.length) storage?.removeItem(KEY);
    else storage?.setItem(KEY, JSON.stringify(v));
  } catch {
    // Private mode or blocked storage: favourites simply do not persist on this device.
  }
}

export function toggleLocal(v: LocalFavorites, kind: 'team' | 'competition', item: TeamRef | CompetitionRef, provider: string): LocalFavorites {
  // Favourites belong to one data source; switching sources starts a fresh list.
  const base = v.provider && v.provider !== provider ? EMPTY_LOCAL : v;
  const list = kind === 'team' ? base.teams : base.competitions;
  const has = list.some((x) => x.id === item.id);
  const next = has ? list.filter((x) => x.id !== item.id) : [...list, item].slice(0, MAX_LOCAL);
  return kind === 'team' ? { ...base, provider, teams: next as TeamRef[] } : { ...base, provider, competitions: next as CompetitionRef[] };
}

const TZ_KEY = 'ks_time_zone';
export function readTimeZonePref(storage: Pick<Storage, 'getItem'> | null): string | null {
  try {
    const v = storage?.getItem(TZ_KEY);
    return v && isTimeZone(v) ? v : null;
  } catch {
    return null;
  }
}
export function writeTimeZonePref(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, tz: string | null) {
  try {
    if (tz) storage?.setItem(TZ_KEY, tz);
    else storage?.removeItem(TZ_KEY);
  } catch {
    // ignored: the browser zone is used
  }
}

export function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
