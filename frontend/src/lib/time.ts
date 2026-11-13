import { formatInTimeZone } from 'date-fns-tz';

/** Position of [start, end) inside [t0, t1] as percentages, clamped to the track. */
export function segment(start: number, end: number, t0: number, t1: number) {
  const span = t1 - t0;
  if (span <= 0) return { left: 0, width: 0 };
  const l = Math.min(100, Math.max(0, ((start - t0) / span) * 100));
  const r = Math.min(100, Math.max(0, ((end - t0) / span) * 100));
  return { left: l, width: Math.max(0, r - l) };
}

/** Whole local hours inside [t0, t1], as track percentages with labels. */
export function hourTicks(t0: number, t1: number, tz: string) {
  const minute = Number(formatInTimeZone(t0, tz, 'm'));
  let t = t0 + ((60 - minute) % 60) * 60_000;
  const out: { pct: number; label: string }[] = [];
  for (; t <= t1; t += 3_600_000) out.push({ pct: ((t - t0) / (t1 - t0)) * 100, label: formatInTimeZone(t, tz, 'ha').toLowerCase() });
  return out;
}

export const fmtTime = (ms: number, tz: string) => formatInTimeZone(ms, tz, 'h:mm a');
export const fmtDay = (ms: number, tz: string) => formatInTimeZone(ms, tz, 'EEE d MMM');
export const fmtRange = (a: number, b: number, tz: string) => `${fmtTime(a, tz)} – ${fmtTime(b, tz)}`;
export const fmtFull = (ms: number, tz: string) => formatInTimeZone(ms, tz, 'EEEE d MMMM, h:mm a');
export const minutesBetween = (a: number, b: number) => Math.round((b - a) / 60_000);
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
