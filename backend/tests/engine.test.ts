import { describe, it, expect } from 'vitest';
import { commonAvailability, findSlots, type EngineInput } from '../src/scheduling/engine';
import { localDateOf, localMinutesOf, localMs } from '../src/utils/timezone';
import { isFree, type Interval } from '../src/utils/intervals';

const TZ = 'UTC';
const t = (date: string, hhmm: string, tz = TZ) => {
  const [h, m] = hhmm.split(':').map(Number);
  return localMs(date, h * 60 + m, tz);
};
const blk = (date: string, a: string, b: string): Interval => ({ start: t(date, a), end: t(date, b) });
const NOW = t('2026-11-07', '09:00'); // Saturday

function base(over: Partial<EngineInput> = {}): EngineInput {
  return {
    organizerEmail: 'me@x.com',
    organizerTz: TZ,
    startDate: '2026-11-09',
    endDate: '2026-11-13',
    durationMinutes: 45,
    participants: [
      { email: 'me@x.com', name: 'Me', required: true, busy: [] },
      { email: 'sarah@x.com', name: 'Sarah', required: true, busy: [] },
    ],
    workingHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
    excludedDays: [],
    nowMs: NOW,
    ...over,
  };
}

describe('scheduling engine', () => {
  it('matches the specification example (User, Sarah, Alex busy periods)', () => {
    const d = '2026-11-10';
    const input = base({
      startDate: d,
      endDate: d,
      participants: [
        { email: 'me@x.com', required: true, busy: [blk(d, '10:00', '11:00'), blk(d, '13:00', '14:00')] },
        { email: 'sarah@x.com', required: true, busy: [blk(d, '09:00', '10:30'), blk(d, '15:00', '16:00')] },
        { email: 'alex@x.com', required: true, busy: [blk(d, '11:00', '12:00'), blk(d, '14:30', '15:30')] },
      ],
      maxResults: 100,
    });
    const r = findSlots(input);
    expect(r.slots.length).toBeGreaterThan(0);
    for (const s of r.slots) {
      for (const p of input.participants) expect(isFree(p.busy!, { start: s.startUtc, end: s.endUtc })).toBe(true);
      expect(s.endUtc - s.startUtc).toBe(45 * 60000);
    }
    // Common free windows: 12:00-13:00, 14:00-14:30 (too short for 45 min), 16:00-18:00
    const starts = r.slots.map((s) => localMinutesOf(s.startUtc, TZ));
    const ok = (m: number) => (m >= 12 * 60 && m <= 12 * 60 + 15) || (m >= 16 * 60 && m <= 17 * 60 + 15);
    expect(starts.every(ok)).toBe(true);
    expect(starts).toContain(12 * 60);
    expect(starts).toContain(16 * 60);
    expect(starts.some((m) => m >= 14 * 60 && m < 15 * 60)).toBe(false);
  });

  it('applies "after 2 PM" and "avoid Friday" as hard constraints', () => {
    const r = findSlots(base({ preferredAfter: '14:00', excludedDays: [5], maxResults: 50 }));
    expect(r.slots.length).toBeGreaterThan(0);
    for (const s of r.slots) {
      expect(localMinutesOf(s.startUtc, TZ)).toBeGreaterThanOrEqual(14 * 60);
      expect(localDateOf(s.startUtc, TZ)).not.toBe('2026-11-13');
    }
  });

  it('returns the top three on distinct days when possible, best first', () => {
    const r = findSlots(base({ preferredAfter: '14:00' }));
    expect(r.slots).toHaveLength(3);
    expect(new Set(r.slots.map((s) => localDateOf(s.startUtc, TZ))).size).toBe(3);
    expect(r.slots[0].score).toBeGreaterThanOrEqual(r.slots[1].score);
    expect(r.slots[1].score).toBeGreaterThanOrEqual(r.slots[2].score);
    expect(r.slots[0].explanation).toMatch(/All 2 required participants are free/);
  });

  it('never proposes weekends or times outside working hours', () => {
    const r = findSlots(base({ startDate: '2026-11-07', endDate: '2026-11-15', maxResults: 200 }));
    for (const s of r.slots) {
      const wd = new Date(s.startUtc).getUTCDay();
      expect([0, 6]).not.toContain(wd);
      expect(localMinutesOf(s.startUtc, TZ)).toBeGreaterThanOrEqual(9 * 60);
      expect(localMinutesOf(s.endUtc, TZ)).toBeLessThanOrEqual(18 * 60);
    }
  });

  it('never proposes times in the past', () => {
    const now = t('2026-11-10', '15:00');
    const r = findSlots(base({ nowMs: now, startDate: '2026-11-10', endDate: '2026-11-10', maxResults: 50 }));
    expect(r.slots.length).toBeGreaterThan(0);
    for (const s of r.slots) expect(s.startUtc).toBeGreaterThanOrEqual(now);
  });

  it('respects allowedDays (Monday or Wednesday)', () => {
    const r = findSlots(base({ allowedDays: [1, 3], maxResults: 50 }));
    for (const s of r.slots) expect([1, 3]).toContain(new Date(s.startUtc).getUTCDay());
  });

  it('returns diagnostics instead of slots when nobody is free', () => {
    const d = '2026-11-10';
    const r = findSlots(
      base({
        startDate: d,
        endDate: d,
        participants: [
          { email: 'me@x.com', required: true, busy: [] },
          { email: 'sarah@x.com', name: 'Sarah', required: true, busy: [blk(d, '00:00', '23:59')] },
        ],
      }),
    );
    expect(r.slots).toEqual([]);
    expect(r.diagnostics?.message).toMatch(/Sarah/);
    expect(r.diagnostics?.blockedBy[0].email).toBe('sarah@x.com');
    expect(r.diagnostics?.suggestions).toContain('Mark Sarah as optional');
  });

  it('explains when the time window is shorter than the meeting', () => {
    const r = findSlots(base({ preferredAfter: '17:30', durationMinutes: 60 }));
    expect(r.slots).toEqual([]);
    expect(r.diagnostics?.message).toMatch(/No days|shorter/);
  });

  it('never treats unknown availability as free', () => {
    const r = findSlots(
      base({
        participants: [
          { email: 'me@x.com', required: true, busy: [] },
          { email: 'ghost@x.com', name: 'Ghost', required: true, busy: null },
        ],
      }),
    );
    expect(r.slots.length).toBeGreaterThan(0);
    for (const s of r.slots) {
      expect(s.availability['ghost@x.com']).toBe('unknown');
      expect(s.unverified).toEqual(['ghost@x.com']);
      expect(s.explanation).toMatch(/could not be verified/);
    }
    const verified = findSlots(base());
    expect(r.slots[0].score).toBeLessThan(verified.slots[0].score);
  });

  it('keeps slots when only an optional participant is busy, but reports it', () => {
    const d = '2026-11-10';
    const r = findSlots(
      base({
        startDate: d,
        endDate: d,
        participants: [
          { email: 'me@x.com', required: true, busy: [] },
          { email: 'opt@x.com', required: false, busy: [blk(d, '09:00', '12:00')] },
        ],
        maxResults: 100,
      }),
    );
    const morning = r.slots.filter((s) => s.availability['opt@x.com'] === 'busy');
    expect(r.slots.length).toBeGreaterThan(0);
    expect(morning.every((s) => s.explanation.includes('optional'))).toBe(true);
    expect(r.slots[0].availability['opt@x.com']).toBe('free');
  });

  it('prefers the requested period as a soft preference', () => {
    const r = findSlots(base({ preferredPeriod: 'afternoon', maxResults: 3 }));
    expect(r.slots.every((s) => localMinutesOf(s.startUtc, TZ) >= 12 * 60)).toBe(true);
  });

  it('computes participant-local times in different time zones across DST', () => {
    const r = findSlots(
      base({
        organizerTz: 'Asia/Kolkata',
        startDate: '2026-03-09',
        endDate: '2026-03-09',
        nowMs: Date.parse('2026-03-01T00:00:00Z'),
        participants: [
          { email: 'me@x.com', required: true, busy: [] },
          { email: 'ny@x.com', name: 'Nina', required: true, timezone: 'America/New_York', busy: [] },
        ],
      }),
    );
    const s = r.slots[0];
    const ny = s.localTimes.find((l) => l.timezone === 'America/New_York')!;
    const ist = s.localTimes.find((l) => l.timezone === 'Asia/Kolkata')!;
    expect(ny).toBeDefined();
    expect(ist).toBeDefined();
    // 2026-03-09 is after US DST began (EDT = UTC-4), IST = UTC+5:30 -> 9.5h difference
    const diff = localMinutesOf(s.startUtc, 'Asia/Kolkata') - localMinutesOf(s.startUtc, 'America/New_York');
    expect(((diff % 1440) + 1440) % 1440).toBe(9 * 60 + 30);
  });

  it('exposes timeline data without event titles', () => {
    const d = '2026-11-10';
    const r = findSlots(base({ startDate: d, endDate: d, participants: [{ email: 'me@x.com', required: true, busy: [blk(d, '10:00', '11:00')] }] }));
    const row = r.slots[0].timeline.rows[0];
    expect(row.label).toBe('You');
    expect(row.busy).toEqual([blk(d, '10:00', '11:00')]);
    expect(Object.keys(row)).not.toContain('title');
  });

  it('commonAvailability intersects many lists', () => {
    expect(commonAvailability([[{ start: 0, end: 10 }], [{ start: 5, end: 15 }], [{ start: 8, end: 9 }]])).toEqual([{ start: 8, end: 9 }]);
    expect(commonAvailability([])).toEqual([]);
  });
});
