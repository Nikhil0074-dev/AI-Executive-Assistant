import { describe, expect, it } from 'vitest';
import { fmtDay, fmtRange, hourTicks, minutesBetween, segment } from './time';

describe('timeline math', () => {
  it('maps intervals to percentages of the track', () => {
    expect(segment(25, 75, 0, 100)).toEqual({ left: 25, width: 50 });
  });
  it('clamps intervals that overflow the track', () => {
    expect(segment(-50, 50, 0, 100)).toEqual({ left: 0, width: 50 });
    expect(segment(80, 500, 0, 100)).toEqual({ left: 80, width: 20 });
    expect(segment(200, 300, 0, 100)).toEqual({ left: 100, width: 0 });
  });
  it('handles an empty track without dividing by zero', () => {
    expect(segment(1, 2, 5, 5)).toEqual({ left: 0, width: 0 });
  });
  it('creates hour ticks on local whole hours, including half-hour offset zones', () => {
    const t0 = Date.parse('2026-11-10T03:30:00Z'); // 09:00 in Asia/Kolkata
    const t1 = Date.parse('2026-11-10T07:30:00Z'); // 13:00
    const ticks = hourTicks(t0, t1, 'Asia/Kolkata');
    expect(ticks.map((t) => t.label)).toEqual(['9am', '10am', '11am', '12pm', '1pm']);
    expect(ticks[0].pct).toBe(0);
    expect(ticks[4].pct).toBe(100);
  });
});

describe('formatting', () => {
  const ms = Date.parse('2026-11-10T08:30:00Z');
  it('formats in the requested time zone', () => {
    expect(fmtRange(ms, ms + 45 * 60_000, 'Asia/Kolkata')).toBe('2:00 PM – 2:45 PM');
    expect(fmtRange(ms, ms + 45 * 60_000, 'UTC')).toBe('8:30 AM – 9:15 AM');
    expect(fmtDay(ms, 'Pacific/Auckland')).toBe('Tue 10 Nov');
  });
  it('computes durations', () => {
    expect(minutesBetween(0, 45 * 60_000)).toBe(45);
  });
});
