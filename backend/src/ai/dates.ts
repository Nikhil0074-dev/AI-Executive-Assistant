import { addDays, localDateOf, weekdayOf } from '../utils/timezone';

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function lastDayOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function firstDayOfNextMonth(date: string): string {
  return addDays(lastDayOfMonth(date), 1);
}

/** Next date with the given weekday. `inclusive` lets today count. */
export function nextOccurrence(today: string, weekday: number, inclusive: boolean): string {
  let diff = (weekday - weekdayOf(today) + 7) % 7;
  if (diff === 0 && !inclusive) diff = 7;
  return addDays(today, diff);
}

export function rangeForKeyword(
  keyword: 'today' | 'tomorrow' | 'this_week' | 'next_week',
  nowMs: number,
  tz: string,
): { start: string; end: string } {
  const today = localDateOf(nowMs, tz);
  const wd = weekdayOf(today);
  switch (keyword) {
    case 'today':
      return { start: today, end: today };
    case 'tomorrow':
      return { start: addDays(today, 1), end: addDays(today, 1) };
    case 'this_week':
      return { start: today, end: addDays(today, (7 - wd) % 7) };
    case 'next_week': {
      let toMonday = (1 - wd + 7) % 7;
      if (toMonday === 0) toMonday = 7;
      const start = addDays(today, toMonday);
      return { start, end: addDays(start, 6) };
    }
  }
}
