import { z } from 'zod';
import { newId } from '../store';
import type { InvitationDraft, User } from '../types';
import { AppError, CalendarDisconnectedError } from '../utils/errors';
import { formatLocal } from '../utils/timezone';
import { isFree } from '../utils/intervals';
import type { Deps } from './deps';
import type { SchedulingService } from './scheduling';

const emailSchema = z.string().trim().toLowerCase().email();
export const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    location: z.string().trim().max(200).optional(),
    addMeet: z.boolean().optional(),
    removeAttendees: z.array(emailSchema).optional(),
    addAttendees: z.array(z.object({ email: emailSchema, name: z.string().trim().max(80).optional(), required: z.boolean().default(true) })).max(20).optional(),
  })
  .strict();

export class InvitationService {
  constructor(private d: Deps, private scheduling: SchedulingService) {}

  owned(user: User, id: string): InvitationDraft {
    const draft = this.d.store.drafts.get(id);
    if (!draft || draft.userId !== user.id) throw new AppError(404, 'NOT_FOUND', 'Invitation draft not found');
    return draft;
  }

  create(user: User, requestId: string, slotId: string): InvitationDraft {
    const { store, now } = this.d;
    const req = this.scheduling.owned(user, requestId);
    const slot = req.slots.find((s) => s.id === slotId);
    if (!slot) throw new AppError(404, 'SLOT_NOT_FOUND', 'That time slot is not part of this request');
    const open = [...store.drafts.values()].find((x) => x.userId === user.id && x.requestId === requestId && x.slotId === slotId && ['awaiting_confirmation', 'failed'].includes(x.status));
    if (open) return open;
    const attendees = req.participants.map((p) => ({ email: p.email, name: p.name, required: p.required }));
    const names = req.participants.map((p) => p.name);
    const title = req.parsed.title ?? (names.length ? `Meeting with ${names.join(', ')}` : 'Meeting');
    const when = formatLocal(slot.startUtc, user.timezone, 'EEEE d MMMM yyyy, h:mm a') + ' – ' + formatLocal(slot.endUtc, user.timezone, 'h:mm a');
    const draft: InvitationDraft = {
      id: newId('inv'), userId: user.id, requestId, slotId, title,
      description: `${title}\n\nScheduled with AI Executive Assistant.\nWhen: ${when} (${user.timezone})\nParticipants: ${[user.name, ...names].join(', ')}`,
      startUtc: slot.startUtc, endUtc: slot.endUtc, timezone: user.timezone, attendees,
      location: req.parsed.wantsMeet ? 'Google Meet' : '', addMeet: req.parsed.wantsMeet,
      unverified: slot.unverified, status: 'awaiting_confirmation', createdAt: now(), updatedAt: now(),
    };
    store.drafts.set(draft.id, draft);
    store.log(user.id, 'invitation.draft', 'draft', draft.id);
    return draft;
  }

  update(user: User, id: string, raw: unknown): InvitationDraft {
    const draft = this.owned(user, id);
    if (!['awaiting_confirmation', 'failed'].includes(draft.status)) throw new AppError(409, 'DRAFT_LOCKED', `A ${draft.status} invitation cannot be edited`);
    const p = patchSchema.parse(raw);
    if (p.title !== undefined) draft.title = p.title;
    if (p.description !== undefined) draft.description = p.description;
    if (p.location !== undefined) draft.location = p.location;
    if (p.addMeet !== undefined) {
      draft.addMeet = p.addMeet;
      if (p.addMeet && !draft.location) draft.location = 'Google Meet';
      if (!p.addMeet && draft.location === 'Google Meet') draft.location = '';
    }
    if (p.removeAttendees?.length) {
      draft.attendees = draft.attendees.filter((a) => !p.removeAttendees!.includes(a.email));
      draft.unverified = draft.unverified.filter((e) => !p.removeAttendees!.includes(e));
    }
    for (const a of p.addAttendees ?? []) {
      if (a.email === user.email || draft.attendees.some((x) => x.email === a.email)) continue;
      draft.attendees.push({ email: a.email, name: a.name ?? a.email, required: a.required });
      draft.unverified.push(a.email); // availability not checked for people added after the search
    }
    draft.updatedAt = this.d.now();
    return draft;
  }

  cancel(user: User, id: string): InvitationDraft {
    const draft = this.owned(user, id);
    if (draft.status === 'created') throw new AppError(409, 'ALREADY_CREATED', 'This invitation was already sent');
    if (draft.status === 'creating') throw new AppError(409, 'IN_PROGRESS', 'This invitation is being created');
    draft.status = 'cancelled';
    draft.updatedAt = this.d.now();
    this.d.store.log(user.id, 'invitation.cancel', 'draft', draft.id);
    return draft;
  }

  async confirm(user: User, id: string, acknowledgeUnverified: boolean): Promise<InvitationDraft> {
    const { store, calendar, now } = this.d;
    const draft = this.owned(user, id);
    if (draft.status === 'created') return draft; // idempotent replay of the same confirmation
    if (draft.status === 'creating') throw new AppError(409, 'IN_PROGRESS', 'This invitation is already being created');
    if (draft.status === 'cancelled') throw new AppError(409, 'DRAFT_CANCELLED', 'This invitation was cancelled');
    if (!user.calendar.connected) throw new AppError(409, 'CALENDAR_DISCONNECTED', 'Reconnect Google Calendar to send this invitation.');
    if (draft.unverified.length && !acknowledgeUnverified)
      throw new AppError(409, 'NEEDS_ACKNOWLEDGEMENT', 'Some attendees\' availability could not be verified. Confirm to proceed anyway.', { unverified: draft.unverified });

    const attendeeKey = [user.email, ...draft.attendees.map((a) => a.email)].sort().join(',');
    for (const other of store.drafts.values()) {
      if (other.id !== draft.id && other.userId === user.id && other.status === 'created' && other.startUtc === draft.startUtc && [user.email, ...other.attendees.map((a) => a.email)].sort().join(',') === attendeeKey)
        throw new AppError(409, 'DUPLICATE_EVENT', 'A meeting with the same people at this time was already created.');
    }

    draft.status = 'creating';
    draft.error = undefined;
    try {
      // Final validation: availability can change between search and confirmation.
      const emails = [user.email, ...draft.attendees.filter((a) => a.required).map((a) => a.email)];
      const fb = await calendar.freeBusy(user, emails, draft.startUtc - 1, draft.endUtc + 1, draft.timezone);
      const slot = { start: draft.startUtc, end: draft.endUtc };
      const conflicts = emails.filter((e) => fb[e] && 'busy' in fb[e] && !isFree((fb[e] as { busy: { start: number; end: number }[] }).busy, slot));
      if (conflicts.length) {
        draft.status = 'awaiting_confirmation';
        const req = this.scheduling.owned(user, draft.requestId);
        let alternatives: unknown[] = [];
        try {
          alternatives = (await this.scheduling.search(user, req)).slots;
        } catch { /* alternatives are best-effort */ }
        throw new AppError(409, 'SLOT_UNAVAILABLE', 'That time is no longer free for everyone. Pick another slot.', { conflicts, alternatives });
      }
      const created = await calendar.createEvent(user, {
        idempotencyKey: draft.id.replace(/[^0-9a-f]/g, '').slice(0, 32),
        title: draft.title, description: draft.description, location: draft.location,
        startUtc: draft.startUtc, endUtc: draft.endUtc, timezone: draft.timezone,
        attendees: draft.attendees.map((a) => ({ email: a.email, name: a.name, optional: !a.required })),
        addMeet: draft.addMeet,
      });
      Object.assign(draft, { status: 'created', eventId: created.id, htmlLink: created.htmlLink, meetLink: created.meetLink, updatedAt: now() });
      const req = store.requests.get(draft.requestId);
      if (req) req.status = 'booked';
      store.log(user.id, 'event.create', 'draft', draft.id);
      return draft;
    } catch (e) {
      if (e instanceof AppError && e.code === 'SLOT_UNAVAILABLE') throw e;
      draft.status = 'failed';
      draft.updatedAt = now();
      store.log(user.id, 'event.create', 'draft', draft.id, 'error');
      if (e instanceof CalendarDisconnectedError) {
        draft.error = 'Google Calendar is disconnected.';
        throw new AppError(409, 'CALENDAR_DISCONNECTED', 'Reconnect Google Calendar to send this invitation. Your draft was kept.');
      }
      draft.error = 'The calendar event could not be created.';
      throw new AppError(502, 'EVENT_CREATION_FAILED', 'The calendar event could not be created. Your draft was kept, so you can retry.', { draftId: draft.id });
    }
  }
}
