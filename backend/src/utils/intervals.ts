/** Half-open interval [start, end) in epoch milliseconds (UTC instants). */
export interface Interval {
  start: number;
  end: number;
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list
    .filter((i) => i.end > i.start)
    .map((i) => ({ ...i }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push(cur);
  }
  return out;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** True when `slot` does not overlap any interval in `busy`. */
export function isFree(busy: Interval[], slot: Interval): boolean {
  return !busy.some((b) => overlaps(b, slot));
}

/** Free periods inside `window` given merged busy intervals. */
export function invert(busyMerged: Interval[], window: Interval): Interval[] {
  const free: Interval[] = [];
  let cursor = window.start;
  for (const b of busyMerged) {
    if (b.end <= window.start) continue;
    if (b.start >= window.end) break;
    if (b.start > cursor) free.push({ start: cursor, end: Math.min(b.start, window.end) });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  return free;
}

/** Intersection of two sorted, merged interval lists. */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (start < end) out.push({ start, end });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

export function clip(list: Interval[], window: Interval): Interval[] {
  return list
    .filter((i) => overlaps(i, window))
    .map((i) => ({ start: Math.max(i.start, window.start), end: Math.min(i.end, window.end) }));
}
