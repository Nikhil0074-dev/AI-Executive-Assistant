export interface User {
  id: string; name: string; email: string; timezone: string;
  workingHours: { start: string; end: string; days: number[] };
  calendar: { connected: boolean; provider: 'mock' | 'google'; accountEmail?: string; connectedAt?: number };
}
export interface Interval { start: number; end: number }
export type Availability = 'free' | 'busy' | 'unknown';
export interface Slot {
  id: string; startUtc: number; endUtc: number; score: number;
  availability: Record<string, Availability>; unverified: string[]; reasons: string[]; explanation: string;
  localTimes: { email: string; label: string; timezone: string; text: string }[];
  timeline: { start: number; end: number; rows: { email: string; label: string; status: Availability; busy: Interval[] }[] };
}
export interface Question {
  id: string; field: 'duration' | 'dateRange' | 'participants' | 'participantEmail' | 'participantChoice';
  prompt: string; name?: string; error?: string; options?: { value: string; label: string }[];
}
export interface Answers {
  durationMinutes?: number; dateRangeKeyword?: string; participantEmails?: Record<string, string>; extraParticipants?: string[];
}
export interface SchedulingRequest {
  id: string; prompt: string; status: 'needs_clarification' | 'ready' | 'no_availability' | 'failed' | 'booked';
  parserSource: 'llm' | 'rules';
  parsed: { durationMinutes?: number; dateRange?: { start: string; end: string }; excludedDays: number[]; preferredAfter?: string; preferredBefore?: string; preferredPeriod?: string };
  participants: { email: string; name: string; required: boolean; access: string }[];
  slots: Slot[]; questions: Question[]; warnings: string[];
  diagnostics?: { message: string; suggestions: string[] };
}
export interface Invitation {
  id: string; requestId: string; title: string; description: string; startUtc: number; endUtc: number; timezone: string;
  attendees: { email: string; name: string; required: boolean }[]; location: string; addMeet: boolean; unverified: string[];
  status: 'awaiting_confirmation' | 'creating' | 'created' | 'failed' | 'cancelled'; htmlLink?: string; meetLink?: string; createdAt: number;
}
export interface CalEvent { id: string; title: string; startUtc: number; endUtc: number; attendees: string[]; meetLink?: string; htmlLink?: string }
export interface Participant { id: string; name: string; email: string; timezone?: string; required: boolean }
