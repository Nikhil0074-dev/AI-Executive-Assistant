import { z } from 'zod';
import type { ParsedRequest, Question } from '../types';
import { addDays } from '../utils/timezone';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected yyyy-MM-dd');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

export const parsedRequestSchema = z.object({
  durationMinutes: z.number().int().min(5).max(480).optional(),
  participants: z
    .array(
      z
        .object({
          name: z.string().trim().min(1).max(80).optional(),
          email: z.string().trim().toLowerCase().email().optional(),
          required: z.boolean().optional(),
        })
        .refine((p) => p.name || p.email, 'Participant needs a name or email'),
    )
    .max(30),
  dateRange: z
    .object({ start: dateStr, end: dateStr })
    .refine((r) => r.start <= r.end && r.end <= addDays(r.start, 61), 'Invalid date range (max 62 days)')
    .optional(),
  preferredAfter: hhmm.optional(),
  preferredBefore: hhmm.optional(),
  preferredPeriod: z.enum(['morning', 'afternoon', 'evening']).optional(),
  excludedDays: z.array(z.number().int().min(0).max(6)).default([]),
  allowedDays: z.array(z.number().int().min(0).max(6)).optional(),
  title: z.string().trim().max(120).optional(),
  wantsMeet: z.boolean().default(false),
});

export const answersSchema = z
  .object({
    durationMinutes: z.number().int().min(5).max(480).optional(),
    dateRangeKeyword: z.enum(['today', 'tomorrow', 'this_week', 'next_week']).optional(),
    participantEmails: z.record(z.string(), z.string()).optional(),
    extraParticipants: z.array(z.string()).max(20).optional(),
  })
  .default({});

/** Questions the assistant must ask before it can search (missing/ambiguous information). */
export function missingInformation(p: ParsedRequest): Question[] {
  const qs: Question[] = [];
  if (!p.durationMinutes)
    qs.push({
      id: 'duration',
      field: 'duration',
      prompt: 'How long should the meeting be?',
      options: [15, 30, 45, 60, 90].map((m) => ({ value: String(m), label: m >= 60 && m % 60 === 0 ? `${m / 60} hr` : `${m} min` })),
    });
  if (!p.dateRange)
    qs.push({
      id: 'dateRange',
      field: 'dateRange',
      prompt: 'Which dates should I look at?',
      options: [
        { value: 'today', label: 'Today' },
        { value: 'tomorrow', label: 'Tomorrow' },
        { value: 'this_week', label: 'This week' },
        { value: 'next_week', label: 'Next week' },
      ],
    });
  if (p.participants.length === 0)
    qs.push({ id: 'participants', field: 'participants', prompt: 'Who should attend? Enter one or more email addresses.' });
  return qs;
}
