import { describe, it, expect } from 'vitest';
import { addDays, eachDate, formatLocal, isValidTimeZone, localDateOf, localMinutesOf, localMs, minutesOf, hhmmOf, weekdayOf } from '../src/utils/timezone';

describe('timezone utils', () => {
  it('validates IANA zones', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
  it('converts wall-clock time to UTC instants', () => {
    expect(new Date(localMs('2026-11-10', 14 * 60, 'Asia/Kolkata')).toISOString()).toBe('2026-11-10T08:30:00.000Z');
    expect(new Date(localMs('2026-11-10', 9 * 60, 'UTC')).toISOString()).toBe('2026-11-10T09:00:00.000Z');
  });
  it('handles the US spring-forward DST transition (offset changes by 1 hour)', () => {
    expect(new Date(localMs('2026-03-07', 9 * 60, 'America/New_York')).toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(new Date(localMs('2026-03-09', 9 * 60, 'America/New_York')).toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });
  it('handles the London fall-back transition', () => {
    expect(new Date(localMs('2026-10-24', 9 * 60, 'Europe/London')).toISOString()).toBe('2026-10-24T08:00:00.000Z');
    expect(new Date(localMs('2026-10-26', 9 * 60, 'Europe/London')).toISOString()).toBe('2026-10-26T09:00:00.000Z');
  });
  it('handles minutes >= 1440 as next-day midnight', () => {
    expect(new Date(localMs('2026-11-10', 1440, 'UTC')).toISOString()).toBe('2026-11-11T00:00:00.000Z');
  });
  it('computes local date/minutes across a date boundary', () => {
    const ms = Date.parse('2026-11-10T20:00:00Z');
    expect(localDateOf(ms, 'Asia/Kolkata')).toBe('2026-11-11');
    expect(localMinutesOf(ms, 'Asia/Kolkata')).toBe(1 * 60 + 30);
    expect(formatLocal(ms, 'UTC', 'HH:mm')).toBe('20:00');
  });
  it('does date arithmetic without timezone drift', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayOf('2026-11-08')).toBe(0);
    expect(eachDate('2026-11-09', '2026-11-11')).toEqual(['2026-11-09', '2026-11-10', '2026-11-11']);
    expect(eachDate('2026-01-01', '2030-01-01').length).toBe(62);
  });
  it('round-trips HH:mm', () => {
    expect(minutesOf('14:30')).toBe(870);
    expect(hhmmOf(870)).toBe('14:30');
  });
});
