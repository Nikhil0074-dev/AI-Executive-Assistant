import type { CalendarEvent, User } from '../types';
import type { Interval } from '../utils/intervals';

export type FreeBusyResult = { busy: Interval[] } | { error: 'notFound' | 'forbidden' | 'unavailable' };

export interface CreateEventInput {
  idempotencyKey: string;
  title: string;
  description: string;
  location: string;
  startUtc: number;
  endUtc: number;
  timezone: string;
  attendees: { email: string; name?: string; optional: boolean }[];
  addMeet: boolean;
}

export interface CreatedEvent {
  id: string;
  htmlLink?: string;
  meetLink?: string;
}

export interface CalendarProvider {
  readonly mode: 'mock' | 'google';
  /** URL to send the user to for consent, or null when connection is immediate (mock). */
  authUrl(user: User): string | null;
  connect(user: User, code?: string): Promise<void>;
  disconnect(user: User): Promise<void>;
  freeBusy(user: User, emails: string[], startMs: number, endMs: number, tz: string): Promise<Record<string, FreeBusyResult>>;
  listEvents(user: User, fromMs: number, toMs: number, tz: string): Promise<CalendarEvent[]>;
  createEvent(user: User, input: CreateEventInput): Promise<CreatedEvent>;
}
