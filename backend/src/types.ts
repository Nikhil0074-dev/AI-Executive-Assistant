import type { Interval } from './utils/intervals';

export interface WorkingHours {
  start: string; // HH:mm
  end: string; // HH:mm
  days: number[]; // 0 = Sunday
}

export interface CalendarConnection {
  connected: boolean;
  provider: 'mock' | 'google';
  accountEmail?: string;
  connectedAt?: number;
  scopes?: string[];
  /** Encrypted with AES-256-GCM; never sent to the frontend. */
  encryptedAccessToken?: string;
  encryptedRefreshToken?: string;
  tokenExpiry?: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  timezone: string;
  workingHours: WorkingHours;
  calendar: CalendarConnection;
  createdAt: number;
}

export interface Participant {
  id: string;
  ownerId: string;
  name: string;
  email: string;
  timezone?: string;
  required: boolean;
  createdAt: number;
}

export type Period = 'morning' | 'afternoon' | 'evening';

export interface ParsedRequest {
  durationMinutes?: number;
  participants: { name?: string; email?: string; required?: boolean }[];
  dateRange?: { start: string; end: string };
  preferredAfter?: string;
  preferredBefore?: string;
  preferredPeriod?: Period;
  excludedDays: number[];
  allowedDays?: number[];
  title?: string;
  wantsMeet: boolean;
}

export type Availability = 'free' | 'busy' | 'unknown';

export interface TimelineRow {
  email: string;
  label: string;
  status: Availability;
  busy: Interval[];
}

export interface Slot {
  id: string;
  startUtc: number;
  endUtc: number;
  score: number;
  availability: Record<string, Availability>;
  unverified: string[];
  reasons: string[];
  explanation: string;
  localTimes: { email: string; label: string; timezone: string; text: string }[];
  timeline: { start: number; end: number; rows: TimelineRow[] };
}

export interface ResolvedParticipant {
  email: string;
  name: string;
  required: boolean;
  timezone?: string;
  access: 'ok' | 'denied' | 'not_found' | 'unknown';
}

export interface Question {
  id: string;
  field: 'duration' | 'dateRange' | 'participants' | 'participantEmail' | 'participantChoice';
  prompt: string;
  name?: string;
  error?: string;
  options?: { value: string; label: string }[];
}

export type RequestStatus = 'needs_clarification' | 'ready' | 'no_availability' | 'failed' | 'booked';

export interface SchedulingRequest {
  id: string;
  userId: string;
  prompt: string;
  parsed: ParsedRequest;
  parserSource: 'llm' | 'rules';
  answers: Answers;
  status: RequestStatus;
  participants: ResolvedParticipant[];
  slots: Slot[];
  questions: Question[];
  diagnostics?: Diagnostics;
  warnings: string[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Answers {
  durationMinutes?: number;
  dateRangeKeyword?: 'today' | 'tomorrow' | 'this_week' | 'next_week';
  participantEmails?: Record<string, string>;
  extraParticipants?: string[];
}

export interface Diagnostics {
  message: string;
  suggestions: string[];
  blockedBy: { email: string; count: number }[];
}

export type DraftStatus = 'awaiting_confirmation' | 'creating' | 'created' | 'failed' | 'cancelled';

export interface InvitationDraft {
  id: string;
  userId: string;
  requestId: string;
  slotId: string;
  title: string;
  description: string;
  startUtc: number;
  endUtc: number;
  timezone: string;
  attendees: { email: string; name: string; required: boolean }[];
  location: string;
  addMeet: boolean;
  unverified: string[];
  status: DraftStatus;
  eventId?: string;
  htmlLink?: string;
  meetLink?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AuditEntry {
  id: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  status: 'ok' | 'error';
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface CalendarEvent {
  id: string;
  title: string;
  startUtc: number;
  endUtc: number;
  attendees: string[];
  htmlLink?: string;
  meetLink?: string;
  location?: string;
}
