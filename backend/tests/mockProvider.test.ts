import { describe, it, expect } from 'vitest';
import { MockCalendarProvider } from '../src/calendar/mockProvider';
import type { User } from '../src/types';

const user = { id: 'u1', email: 'me@x.com', calendar: { connected: false, provider: 'mock' } } as User;
const from = Date.parse('2026-11-09T00:00:00Z');
const to = Date.parse('2026-11-14T00:00:00Z');
const input = (key: string, addMeet = false) => ({
  idempotencyKey: key, title: 'T', description: 'D', location: '', startUtc: Date.parse('2026-11-10T22:00:00Z'), endUtc: Date.parse('2026-11-10T22:45:00Z'),
  timezone: 'UTC', attendees: [{ email: 'sarah@x.com', optional: false }], addMeet,
});

describe('MockCalendarProvider', () => {
  it('is deterministic per email and differs between people', async () => {
    const m = new MockCalendarProvider();
    const a = await m.freeBusy(user, ['sarah@x.com', 'alex@x.com'], from, to, 'UTC');
    const b = await new MockCalendarProvider().freeBusy(user, ['sarah@x.com', 'alex@x.com'], from, to, 'UTC');
    expect(a).toEqual(b);
    expect(a['sarah@x.com']).not.toEqual(a['alex@x.com']);
  });
  it('generates only weekday busy time between 09:00 and 18:00', async () => {
    const r = (await new MockCalendarProvider().freeBusy(user, ['a@x.com'], from, Date.parse('2026-11-23T00:00:00Z'), 'UTC'))['a@x.com'];
    expect('busy' in r && r.busy.length).toBeGreaterThan(5);
    if ('busy' in r) for (const b of r.busy) {
      const d = new Date(b.start);
      expect([0, 6]).not.toContain(d.getUTCDay());
      expect(d.getUTCHours()).toBeGreaterThanOrEqual(9);
      expect(new Date(b.end).getUTCHours() * 60 + new Date(b.end).getUTCMinutes()).toBeLessThanOrEqual(18 * 60);
    }
  });
  it('reports private calendars as inaccessible', async () => {
    const r = await new MockCalendarProvider().freeBusy(user, ['hidden@private.example'], from, to, 'UTC');
    expect(r['hidden@private.example']).toEqual({ error: 'forbidden' });
  });
  it('connect/disconnect updates the user connection', async () => {
    const m = new MockCalendarProvider();
    await m.connect(user);
    expect(user.calendar.connected).toBe(true);
    await m.disconnect(user);
    expect(user.calendar.connected).toBe(false);
  });
  it('created events make every attendee busy, and creation is idempotent', async () => {
    const m = new MockCalendarProvider();
    const first = await m.createEvent(user, input('k1', true));
    const again = await m.createEvent(user, input('k1', true));
    expect(again.id).toBe(first.id);
    expect(m.createdEvents).toHaveLength(1);
    expect(first.meetLink).toMatch(/^https:\/\/meet\.google\.com\//);
    const fb = await m.freeBusy(user, ['sarah@x.com', 'zed@x.com'], from, to, 'UTC');
    const hit = (r: typeof fb[string]) => 'busy' in r && r.busy.some((b) => b.start === input('k1').startUtc);
    expect(hit(fb['sarah@x.com'])).toBe(true);
    expect(hit(fb['zed@x.com'])).toBe(false);
    expect((await m.createEvent(user, input('k2'))).meetLink).toBeUndefined();
  });
  it('can simulate API failures once', async () => {
    const m = new MockCalendarProvider();
    m.failNextCreate = new Error('boom');
    await expect(m.createEvent(user, input('k'))).rejects.toThrow('boom');
    await expect(m.createEvent(user, input('k'))).resolves.toBeTruthy();
  });
});
