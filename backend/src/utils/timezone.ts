import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

export const MINUTE = 60_000;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function hhmmOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Inclusive list of yyyy-MM-dd strings (capped to avoid runaway ranges). */
export function eachDate(start: string, end: string, cap = 62): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length < cap; d = addDays(d, 1)) out.push(d);
  return out;
}

/** UTC instant (ms) for a wall-clock time on `date` in `tz`. Uses IANA rules, so DST is handled. */
export function localMs(date: string, minutes: number, tz: string): number {
  if (minutes >= 1440) return localMs(addDays(date, 1), minutes - 1440, tz);
  return fromZonedTime(`${date}T${hhmmOf(minutes)}:00`, tz).getTime();
}

export function localDateOf(ms: number, tz: string): string {
  return formatInTimeZone(ms, tz, 'yyyy-MM-dd');
}

export function localMinutesOf(ms: number, tz: string): number {
  return minutesOf(formatInTimeZone(ms, tz, 'HH:mm'));
}

export function formatLocal(ms: number, tz: string, fmt = 'EEE d MMM, h:mm a'): string {
  return formatInTimeZone(ms, tz, fmt);
}
