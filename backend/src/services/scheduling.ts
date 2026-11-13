import { z } from 'zod';
import { answersSchema, missingInformation } from '../ai/schema';
import { rangeForKeyword } from '../ai/dates';
import { findSlots, type EngineParticipant } from '../scheduling/engine';
import { newId } from '../store';
import type { Answers, ParsedRequest, Participant, Question, ResolvedParticipant, SchedulingRequest, User } from '../types';
import { AppError, CalendarDisconnectedError } from '../utils/errors';
import { addDays, localMs } from '../utils/timezone';
import type { Deps } from './deps';

const emailSchema = z.string().trim().toLowerCase().email();
const bodySchema = z.object({
  prompt: z.string().trim().min(3, 'Describe the meeting you want to schedule').max(1000),
  requestId: z.string().optional(),
  answers: answersSchema,
});

function nameMatches(saved: string, key: string) {
  const s = saved.toLowerCase();
  return s === key || s.split(' ')[0] === key || (key.includes(' ') && s.startsWith(key));
}
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export class SchedulingService {
  constructor(private d: Deps) {}

  async create(user: User, raw: unknown): Promise<SchedulingRequest> {
    const { prompt, requestId, answers } = bodySchema.parse(raw);
    const { store, now } = this.d;
    let req = requestId ? store.requests.get(requestId) : undefined;
    if (requestId && (!req || req.userId !== user.id)) throw new AppError(404, 'NOT_FOUND', 'Scheduling request not found');
    if (req && req.status !== 'needs_clarification') req = undefined;

    const { parsed: base, source } = await this.d.parse(prompt, { nowMs: now(), tz: user.timezone });
    const parsed = this.applyAnswers(user, structuredClone(base), answers);
    const merged: Answers = { ...(req?.answers ?? {}), ...answers, participantEmails: { ...(req?.answers.participantEmails ?? {}), ...(answers.participantEmails ?? {}) } };

    const record: SchedulingRequest = req ?? {
      id: newId('req'), userId: user.id, prompt, parsed, parserSource: source, answers: merged, status: 'needs_clarification',
      participants: [], slots: [], questions: [], warnings: [], createdAt: now(), updatedAt: now(),
    };
    Object.assign(record, { prompt, parsed, parserSource: source, answers: merged, updatedAt: now(), slots: [], diagnostics: undefined, error: undefined, warnings: [] });
    store.requests.set(record.id, record);
    store.log(user.id, 'scheduling.request', 'request', record.id);

    const questions: Question[] = missingInformation(parsed);
    const { resolved, questions: pq } = this.resolveParticipants(user, parsed, merged);
    questions.push(...pq);
    record.participants = resolved;
    if (questions.length) {
      record.status = 'needs_clarification';
      record.questions = questions;
      return record;
    }
    record.questions = [];
    return this.search(user, record);
  }

  async retry(user: User, id: string): Promise<SchedulingRequest> {
    const req = this.owned(user, id);
    if (req.status === 'needs_clarification') throw new AppError(409, 'NEEDS_CLARIFICATION', 'Answer the open questions first');
    return this.search(user, req);
  }

  owned(user: User, id: string): SchedulingRequest {
    const req = this.d.store.requests.get(id);
    if (!req || req.userId !== user.id) throw new AppError(404, 'NOT_FOUND', 'Scheduling request not found');
    return req;
  }

  private applyAnswers(user: User, p: ParsedRequest, a: Answers): ParsedRequest {
    if (a.durationMinutes) p.durationMinutes = a.durationMinutes;
    if (a.dateRangeKeyword) p.dateRange = rangeForKeyword(a.dateRangeKeyword, this.d.now(), user.timezone);
    for (const e of a.extraParticipants ?? []) {
      const parsed = emailSchema.safeParse(e);
      p.participants.push(parsed.success ? { email: parsed.data } : { name: e.trim() || 'Unknown' });
    }
    return p;
  }

  private resolveParticipants(user: User, parsed: ParsedRequest, answers: Answers) {
    const { store, now } = this.d;
    const saved = store.participantsOf(user.id);
    const overrides = Object.fromEntries(Object.entries(answers.participantEmails ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const resolved = new Map<string, ResolvedParticipant>();
    const questions: Question[] = [];
    const add = (r: ResolvedParticipant) => {
      if (r.email !== user.email && !resolved.has(r.email)) resolved.set(r.email, r);
    };
    const fromSaved = (s: Participant, required?: boolean) =>
      add({ email: s.email, name: s.name, required: required ?? s.required, timezone: s.timezone, access: 'unknown' });

    for (const p of parsed.participants) {
      if (p.email) {
        const email = p.email.toLowerCase();
        const s = saved.find((x) => x.email === email);
        add({ email, name: s?.name ?? email, required: p.required ?? s?.required ?? true, timezone: s?.timezone, access: 'unknown' });
        continue;
      }
      const name = p.name!;
      const key = name.toLowerCase();
      const override = overrides[key];
      if (override !== undefined) {
        const ok = emailSchema.safeParse(override);
        if (!ok.success) {
          questions.push({ id: `email:${key}`, field: 'participantEmail', name, prompt: `What is ${name}'s email address?`, error: 'That email address is not valid.' });
          continue;
        }
        let s = saved.find((x) => x.email === ok.data);
        if (!s) {
          s = { id: newId('par'), ownerId: user.id, name: titleCase(name), email: ok.data, required: true, createdAt: now() };
          store.participants.set(s.id, s);
          saved.push(s);
        }
        fromSaved(s, p.required);
        continue;
      }
      const matches = saved.filter((s) => nameMatches(s.name, key));
      if (matches.length === 1) fromSaved(matches[0], p.required);
      else if (matches.length > 1)
        questions.push({
          id: `choice:${key}`, field: 'participantChoice', name, prompt: `Which ${name} do you mean?`,
          options: matches.map((m) => ({ value: m.email, label: `${m.name} (${m.email})` })),
        });
      else questions.push({ id: `email:${key}`, field: 'participantEmail', name, prompt: `I don't have ${name} saved yet. What is their email address?` });
    }
    return { resolved: [...resolved.values()], questions };
  }

  async search(user: User, req: SchedulingRequest): Promise<SchedulingRequest> {
    const { calendar, now } = this.d;
    if (!user.calendar.connected) throw new AppError(409, 'CALENDAR_DISCONNECTED', 'Connect Google Calendar before searching for a time.');
    const p = req.parsed;
    const range = p.dateRange!;
    const tz = user.timezone;
    const startMs = localMs(range.start, 0, tz);
    const endMs = localMs(addDays(range.end, 1), 0, tz);
    const emails = [user.email, ...req.participants.map((x) => x.email)];

    let result;
    try {
      result = await calendar.freeBusy(user, emails, startMs, endMs, tz);
    } catch (e) {
      req.status = 'failed';
      req.updatedAt = now();
      if (e instanceof CalendarDisconnectedError) {
        user.calendar = { ...user.calendar, connected: false };
        req.error = 'Google Calendar is disconnected. Reconnect it and try again.';
        throw new AppError(409, 'CALENDAR_DISCONNECTED', req.error, { requestId: req.id });
      }
      req.error = 'Google Calendar could not be reached. Your request was saved; try again.';
      this.d.store.log(user.id, 'calendar.freebusy', 'request', req.id, 'error');
      throw new AppError(502, 'GOOGLE_API_FAILURE', req.error, { requestId: req.id });
    }

    const own = result[user.email];
    if (!own || 'error' in own) {
      req.status = 'failed';
      req.error = 'Your own calendar could not be read. Reconnect Google Calendar.';
      throw new AppError(502, 'GOOGLE_API_FAILURE', req.error, { requestId: req.id });
    }

    const engineParticipants: EngineParticipant[] = [{ email: user.email, name: user.name, required: true, busy: own.busy }];
    req.warnings = [];
    for (const r of req.participants) {
      const fb = result[r.email];
      if (fb && 'busy' in fb) {
        r.access = 'ok';
        engineParticipants.push({ email: r.email, name: r.name, required: r.required, timezone: r.timezone, busy: fb.busy });
      } else {
        r.access = fb && fb.error === 'notFound' ? 'not_found' : 'denied';
        engineParticipants.push({ email: r.email, name: r.name, required: r.required, timezone: r.timezone, busy: null });
        req.warnings.push(`${r.name}'s calendar is not accessible, so their availability could not be checked. Ask them for free times or confirm manually.`);
      }
    }

    const out = findSlots({
      organizerEmail: user.email,
      organizerTz: tz,
      startDate: range.start,
      endDate: range.end,
      durationMinutes: p.durationMinutes!,
      participants: engineParticipants,
      workingHours: user.workingHours,
      excludedDays: p.excludedDays,
      allowedDays: p.allowedDays,
      preferredAfter: p.preferredAfter,
      preferredBefore: p.preferredBefore,
      preferredPeriod: p.preferredPeriod,
      nowMs: now(),
    });
    req.slots = out.slots;
    req.diagnostics = out.diagnostics;
    req.status = out.slots.length ? 'ready' : 'no_availability';
    req.updatedAt = now();
    this.d.store.log(user.id, 'scheduling.search', 'request', req.id, 'ok', { slots: out.slots.length });
    return req;
  }
}
