import type { CalendarEvent, User } from '../types';
import { AppError } from '../utils/errors';
import { overlaps, type Interval } from '../utils/intervals';
import { eachDate, localDateOf, localMs, weekdayOf, MINUTE } from '../utils/timezone';
import type { CalendarProvider, CreateEventInput, CreatedEvent, FreeBusyResult } from './provider';

const TITLES = ['Team sync', 'Design review', '1:1', 'Planning', 'Customer call', 'Standup', 'Focus block', 'Retro'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic in-memory calendar used for demos and tests. Every email has
 * a stable, pseudo-random weekday schedule (2-3 meetings per workday, in the
 * organizer's time zone). Addresses ending in @private.example are inaccessible.
 */
export class MockCalendarProvider implements CalendarProvider {
  readonly mode = 'mock' as const;
  private created: (CalendarEvent & { key: string; organizer: string })[] = [];
  private extraBusy = new Map<string, Interval[]>();
  failNextCreate: Error | null = null;
  failFreeBusy: Error | null = null;
  createDelayMs = 0;

  authUrl(): string | null {
    return null;
  }
  async connect(user: User): Promise<void> {
    user.calendar = { connected: true, provider: 'mock', accountEmail: user.email, connectedAt: Date.now(), scopes: ['calendar.freebusy', 'calendar.events'] };
  }
  async disconnect(user: User): Promise<void> {
    user.calendar = { connected: false, provider: 'mock' };
  }

  /** Test helper: add a busy block to someone's calendar. */
  addBusy(email: string, interval: Interval) {
    this.extraBusy.set(email, [...(this.extraBusy.get(email) ?? []), interval]);
  }
  get createdEvents() {
    return this.created;
  }

  private generated(email: string, fromMs: number, toMs: number, tz: string): CalendarEvent[] {
    const out: CalendarEvent[] = [];
    for (const date of eachDate(localDateOf(fromMs, tz), localDateOf(toMs, tz), 90)) {
      const wd = weekdayOf(date);
      if (wd === 0 || wd === 6) continue;
      const rand = rng(hash(`${email}|${date}`));
      const count = 2 + Math.floor(rand() * 2);
      const placed: Interval[] = [];
      for (let n = 0; n < count; n++) {
        const startMin = 9 * 60 + Math.floor(rand() * 16) * 30; // 09:00 .. 16:30
        const len = [30, 60, 60, 90][Math.floor(rand() * 4)];
        const iv = { start: localMs(date, startMin, tz), end: localMs(date, startMin + len, tz) };
        if (placed.some((p) => overlaps(p, iv))) continue;
        placed.push(iv);
        out.push({ id: `mock_${hash(email + date + startMin)}`, title: TITLES[Math.floor(rand() * TITLES.length)], startUtc: iv.start, endUtc: iv.end, attendees: [email] });
      }
    }
    return out.filter((e) => e.endUtc > fromMs && e.startUtc < toMs);
  }

  private busyFor(email: string, fromMs: number, toMs: number, tz: string): Interval[] {
    const win = { start: fromMs, end: toMs };
    const fromGenerated = this.generated(email, fromMs, toMs, tz).map((e) => ({ start: e.startUtc, end: e.endUtc }));
    const fromCreated = this.created.filter((e) => e.attendees.includes(email) || e.organizer === email).map((e) => ({ start: e.startUtc, end: e.endUtc }));
    return [...fromGenerated, ...fromCreated, ...(this.extraBusy.get(email) ?? [])].filter((i) => overlaps(i, win));
  }

  async freeBusy(_user: User, emails: string[], startMs: number, endMs: number, tz: string): Promise<Record<string, FreeBusyResult>> {
    if (this.failFreeBusy) throw this.failFreeBusy;
    const out: Record<string, FreeBusyResult> = {};
    for (const email of emails) {
      out[email] = email.endsWith('@private.example') ? { error: 'forbidden' } : { busy: this.busyFor(email, startMs, endMs, tz) };
    }
    return out;
  }

  async listEvents(user: User, fromMs: number, toMs: number, tz: string): Promise<CalendarEvent[]> {
    const mine = this.created.filter((e) => e.organizer === user.email && e.endUtc > fromMs && e.startUtc < toMs);
    return [...this.generated(user.email, fromMs, toMs, tz), ...mine].sort((a, b) => a.startUtc - b.startUtc);
  }

  async createEvent(user: User, input: CreateEventInput): Promise<CreatedEvent> {
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }
    if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs));
    const existing = this.created.find((e) => e.key === input.idempotencyKey);
    if (existing) return { id: existing.id, htmlLink: existing.htmlLink, meetLink: existing.meetLink };
    if (input.endUtc - input.startUtc < 5 * MINUTE) throw new AppError(400, 'INVALID_EVENT', 'Event is too short');
    const id = `evt_${hash(input.idempotencyKey).toString(16)}`;
    const ev = {
      id,
      key: input.idempotencyKey,
      organizer: user.email,
      title: input.title,
      startUtc: input.startUtc,
      endUtc: input.endUtc,
      attendees: [user.email, ...input.attendees.map((a) => a.email)],
      location: input.location,
      htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`,
      meetLink: input.addMeet ? `https://meet.google.com/${id.slice(4, 7)}-${id.slice(7, 11)}-${id.slice(-3)}` : undefined,
    };
    this.created.push(ev);
    return { id, htmlLink: ev.htmlLink, meetLink: ev.meetLink };
  }
}
