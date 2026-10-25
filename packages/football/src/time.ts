/**
 * Calendar-day handling across time zones. Kickoffs are stored and sent in UTC; "today" and date
 * navigation are in the viewer's zone, so a local day can span two UTC days and can be 23 or 25
 * hours long around daylight-saving changes.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidDay(day: string): boolean {
  const m = DAY.exec(day);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === day;
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (positive east of Greenwich). */
export function zoneOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of local midnight starting `day` in `tz`. */
export function localMidnightUtc(day: string, tz: string): Date {
  const m = DAY.exec(day);
  if (!m) throw new Error(`invalid day ${day}`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const first = zoneOffsetMs(guess, tz);
  let t = guess - first;
  const second = zoneOffsetMs(t, tz);
  if (second !== first) t = guess - second;
  return new Date(t);
}

export function addDays(day: string, n: number): string {
  const m = DAY.exec(day);
  if (!m) throw new Error(`invalid day ${day}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
}

/** [start, end) of a local calendar day, as UTC instants. */
export function localDayRange(day: string, tz: string): { start: Date; end: Date } {
  return { start: localMidnightUtc(day, tz), end: localMidnightUtc(addDays(day, 1), tz) };
}

/** The calendar day of instant `at` in `tz`. */
export function dayIn(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** UTC calendar days touched by [start, end). */
export function utcDaysCovering(start: Date, end: Date): string[] {
  const days: string[] = [];
  let d = start.toISOString().slice(0, 10);
  const last = new Date(end.getTime() - 1).toISOString().slice(0, 10);
  while (d <= last) {
    days.push(d);
    d = addDays(d, 1);
  }
  return days;
}
