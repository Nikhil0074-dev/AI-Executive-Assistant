import type { Availability, Period, Slot, TimelineRow, WorkingHours, Diagnostics } from '../types';
import { clip, intersect, invert, isFree, mergeIntervals, type Interval } from '../utils/intervals';
import {
  MINUTE,
  eachDate,
  formatLocal,
  localDateOf,
  localMinutesOf,
  localMs,
  minutesOf,
  weekdayOf,
} from '../utils/timezone';

export interface EngineParticipant {
  email: string;
  name?: string;
  required: boolean;
  timezone?: string;
  /** null = availability unknown (calendar not accessible). Never treated as free. */
  busy: Interval[] | null;
}

export interface EngineInput {
  organizerEmail: string;
  organizerTz: string;
  startDate: string;
  endDate: string;
  durationMinutes: number;
  participants: EngineParticipant[]; // includes the organizer
  workingHours: WorkingHours;
  excludedDays: number[];
  allowedDays?: number[];
  preferredAfter?: string;
  preferredBefore?: string;
  preferredPeriod?: Period;
  nowMs: number;
  stepMinutes?: number;
  maxResults?: number;
}

export interface EngineResult {
  slots: Slot[];
  totalCandidates: number;
  diagnostics?: Diagnostics;
}

const PERIODS: Record<Period, [number, number]> = {
  morning: [9 * 60, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 21 * 60],
};

interface DayInfo {
  date: string;
  index: number;
  window: Interval;
  base: number; // local midnight, used to align candidate starts to the step grid
  lower: number; // earliest permitted start (window start or "now")
}

/** Free time shared by every list (each list sorted + merged). */
export function commonAvailability(freeLists: Interval[][]): Interval[] {
  if (freeLists.length === 0) return [];
  return freeLists.slice(1).reduce((acc, l) => intersect(acc, l), freeLists[0]);
}

function label(p: { name?: string; email: string }) {
  return p.name || p.email;
}

export function findSlots(input: EngineInput): EngineResult {
  const stepMs = (input.stepMinutes ?? 15) * MINUTE;
  const durMs = input.durationMinutes * MINUTE;
  const maxResults = input.maxResults ?? 3;
  const wh = input.workingHours;
  const tz = input.organizerTz;

  const startM = Math.max(minutesOf(wh.start), input.preferredAfter ? minutesOf(input.preferredAfter) : 0);
  const endM = Math.min(minutesOf(wh.end), input.preferredBefore ? minutesOf(input.preferredBefore) : 1440);
  const hardConstrained = Boolean(input.preferredAfter || input.preferredBefore);

  const busyOf = new Map<string, Interval[] | null>();
  for (const p of input.participants) busyOf.set(p.email, p.busy ? mergeIntervals(p.busy) : null);
  const requiredKnown = input.participants.filter((p) => p.required && p.busy !== null);
  const requiredAll = input.participants.filter((p) => p.required);

  const days: DayInfo[] = [];
  eachDate(input.startDate, input.endDate).forEach((date, index) => {
    const wd = weekdayOf(date);
    if (!wh.days.includes(wd)) return;
    if (input.excludedDays.includes(wd)) return;
    if (input.allowedDays?.length && !input.allowedDays.includes(wd)) return;
    if (endM - startM < input.durationMinutes) return;
    const window = { start: localMs(date, startM, tz), end: localMs(date, endM, tz) };
    if (window.end <= input.nowMs) return;
    days.push({
      date,
      index,
      window,
      base: localMs(date, 0, tz),
      lower: Math.max(window.start, input.nowMs),
    });
  });

  const alignUp = (day: DayInfo, t: number) => day.base + Math.ceil((t - day.base) / stepMs) * stepMs;

  const candidates: Slot[] = [];
  for (const day of days) {
    const freeLists = requiredKnown.map((p) => invert(busyOf.get(p.email)!, day.window));
    const common = requiredKnown.length ? commonAvailability(freeLists) : [day.window];
    for (const free of common) {
      for (let s = alignUp(day, Math.max(free.start, day.lower)); s + durMs <= free.end; s += stepMs) {
        candidates.push(buildSlot(s, s + durMs, day));
      }
    }
  }

  function buildSlot(start: number, end: number, day: DayInfo): Slot {
    const slot: Interval = { start, end };
    const availability: Record<string, Availability> = {};
    for (const p of input.participants) {
      const busy = busyOf.get(p.email);
      availability[p.email] = busy === null || busy === undefined ? 'unknown' : isFree(busy, slot) ? 'free' : 'busy';
    }
    const unverified = requiredAll.filter((p) => availability[p.email] === 'unknown').map((p) => p.email);
    const reasons: string[] = [];
    let score = 0;

    const verified = requiredAll.length - unverified.length;
    score += 40 * (verified / Math.max(1, requiredAll.length));
    reasons.push(
      unverified.length === 0
        ? `All ${requiredAll.length} required participant${requiredAll.length === 1 ? ' is' : 's are'} free.`
        : `${verified} of ${requiredAll.length} required calendars confirmed free; availability for ${unverified.length} could not be verified.`,
    );

    const optional = input.participants.filter((p) => !p.required);
    if (optional.length) {
      const freeCount = optional.filter((p) => availability[p.email] === 'free').length;
      score += 10 * (freeCount / optional.length);
      if (freeCount < optional.length) reasons.push(`${optional.length - freeCount} optional participant(s) may not be able to attend.`);
    } else score += 10;

    const startMin = localMinutesOf(start, tz);
    if (hardConstrained) {
      score += 20;
      reasons.push(
        input.preferredAfter && input.preferredBefore
          ? `Fits your ${input.preferredAfter}–${input.preferredBefore} window.`
          : input.preferredAfter
            ? `Starts after ${input.preferredAfter} as requested.`
            : `Ends before ${input.preferredBefore} as requested.`,
      );
    }
    if (input.preferredPeriod) {
      const [a, b] = PERIODS[input.preferredPeriod];
      if (startMin >= a && startMin < b) {
        if (!hardConstrained) score += 20;
        reasons.push(`Matches your ${input.preferredPeriod} preference.`);
      } else if (hardConstrained) score -= 5;
    } else if (!hardConstrained) score += 12;

    const tzParticipants = input.participants.filter((p) => p.timezone);
    if (tzParticipants.length) {
      const ws = minutesOf(wh.start);
      const we = minutesOf(wh.end);
      const ok = tzParticipants.filter((p) => {
        const tzp = p.timezone!;
        return (
          localDateOf(start, tzp) === localDateOf(end - 1, tzp) &&
          localMinutesOf(start, tzp) >= ws &&
          localMinutesOf(end, tzp) <= we
        );
      });
      score += 15 * (ok.length / tzParticipants.length);
      if (ok.length === tzParticipants.length) reasons.push('Within working hours in every known time zone.');
      else reasons.push(`Outside working hours for ${tzParticipants.length - ok.length} participant(s) in their local time.`);
    } else {
      score += 15;
      reasons.push('Within your working hours.');
    }

    score += Math.max(0, 15 - day.index * 3);
    if (day.index === 0) reasons.push('Earliest day in your range.');

    const localTimes = uniqueTimezones(input).map(({ tzName, who }) => ({
      email: who.email,
      label: label(who),
      timezone: tzName,
      text: `${formatLocal(start, tzName)} – ${formatLocal(end, tzName, 'h:mm a')}`,
    }));

    return {
      id: `slot_${start}`,
      startUtc: start,
      endUtc: end,
      score: Math.round(score * 10) / 10,
      availability,
      unverified,
      reasons,
      explanation: reasons.join(' '),
      localTimes,
      timeline: { start: 0, end: 0, rows: [] },
    };
  }

  const sorted = candidates.sort((a, b) => b.score - a.score || a.startUtc - b.startUtc);
  const picked: Slot[] = [];
  const usedDates = new Set<string>();
  for (const s of sorted) {
    const d = localDateOf(s.startUtc, tz);
    if (usedDates.has(d)) continue;
    usedDates.add(d);
    picked.push(s);
    if (picked.length === maxResults) break;
  }
  for (const s of sorted) {
    if (picked.length >= maxResults) break;
    if (!picked.includes(s)) picked.push(s);
  }
  picked.sort((a, b) => b.score - a.score || a.startUtc - b.startUtc);

  for (const s of picked) {
    const date = localDateOf(s.startUtc, tz);
    const win = { start: localMs(date, Math.max(0, minutesOf(wh.start) - 60), tz), end: localMs(date, Math.min(1440, minutesOf(wh.end) + 60), tz) };
    const rows: TimelineRow[] = input.participants.map((p) => ({
      email: p.email,
      label: p.email === input.organizerEmail ? 'You' : label(p),
      status: s.availability[p.email],
      busy: p.busy ? clip(mergeIntervals(p.busy), win) : [],
    }));
    s.timeline = { start: win.start, end: win.end, rows };
  }

  const result: EngineResult = { slots: picked, totalCandidates: candidates.length };
  if (!picked.length) result.diagnostics = diagnose(input, days, alignUp, stepMs, durMs, busyOf);
  return result;
}

function uniqueTimezones(input: EngineInput) {
  const seen = new Set<string>();
  const out: { tzName: string; who: EngineParticipant }[] = [];
  const org = input.participants.find((p) => p.email === input.organizerEmail);
  const list = org ? [org, ...input.participants.filter((p) => p !== org)] : input.participants;
  for (const p of list) {
    const tzName = p.email === input.organizerEmail ? input.organizerTz : p.timezone;
    if (!tzName || seen.has(tzName)) continue;
    seen.add(tzName);
    out.push({ tzName, who: p });
  }
  return out;
}

function diagnose(
  input: EngineInput,
  days: DayInfo[],
  alignUp: (d: DayInfo, t: number) => number,
  stepMs: number,
  durMs: number,
  busyOf: Map<string, Interval[] | null>,
): Diagnostics {
  if (days.length === 0) {
    return {
      message: 'No days in the requested range match your working days, time window, and exclusions.',
      suggestions: ['Expand the date range', 'Include more days', 'Widen the time window', 'Shorten the meeting'],
      blockedBy: [],
    };
  }
  const blocked = new Map<string, number>();
  let raw = 0;
  for (const day of days) {
    for (let s = alignUp(day, day.lower); s + durMs <= day.window.end; s += stepMs) {
      raw++;
      for (const p of input.participants) {
        const busy = busyOf.get(p.email);
        if (busy && !isFree(busy, { start: s, end: s + durMs })) blocked.set(p.email, (blocked.get(p.email) ?? 0) + 1);
      }
    }
  }
  const blockedBy = [...blocked.entries()].map(([email, count]) => ({ email, count })).sort((a, b) => b.count - a.count);
  if (raw === 0) {
    return {
      message: 'The remaining time in the requested window is shorter than the meeting.',
      suggestions: ['Shorten the meeting', 'Widen the time window', 'Expand the date range'],
      blockedBy,
    };
  }
  const top = blockedBy[0];
  const who = top ? input.participants.find((p) => p.email === top.email) : undefined;
  const suggestions = ['Expand the date range', 'Shorten the meeting', 'Relax the time preference'];
  if (who && who.email !== input.organizerEmail) suggestions.splice(2, 0, `Mark ${label(who)} as optional`);
  return {
    message: top
      ? `There is no time when all required participants are free. ${who && who.email === input.organizerEmail ? 'Your own' : `${label(who ?? { email: top.email })}'s`} calendar blocks the most options.`
      : 'There is no time when all required participants are free.',
    suggestions,
    blockedBy,
  };
}
