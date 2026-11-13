import jwt from 'jsonwebtoken';
import type { CalendarEvent, User } from '../types';
import { CalendarDisconnectedError, AppError } from '../utils/errors';
import { decrypt, encrypt } from '../utils/crypto';
import type { CalendarProvider, CreateEventInput, CreatedEvent, FreeBusyResult } from './provider';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
];

export interface GoogleOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: string;
  stateSecret: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const API = 'https://www.googleapis.com/calendar/v3';

export class GoogleCalendarProvider implements CalendarProvider {
  readonly mode = 'google' as const;
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;

  constructor(private o: GoogleOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  /** Signed, short-lived OAuth state bound to the app user (CSRF protection). */
  signState(userId: string): string {
    return jwt.sign({ uid: userId, purpose: 'google-oauth' }, this.o.stateSecret, { expiresIn: '10m' });
  }
  verifyState(state: string, userId: string): boolean {
    try {
      const p = jwt.verify(state, this.o.stateSecret) as { uid: string; purpose: string };
      return p.purpose === 'google-oauth' && p.uid === userId;
    } catch {
      return false;
    }
  }

  authUrl(user: User): string {
    const q = new URLSearchParams({
      client_id: this.o.clientId,
      redirect_uri: this.o.redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: this.signState(user.id),
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  private async tokenRequest(params: Record<string, string>) {
    const res = await this.f('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.o.clientId, client_secret: this.o.clientSecret, ...params }),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      if (data.error === 'invalid_grant') throw new CalendarDisconnectedError('Google access was revoked or expired');
      throw new AppError(502, 'GOOGLE_API_FAILURE', `Google token request failed (${res.status})`);
    }
    return data as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string; scope?: string };
  }

  async connect(user: User, code?: string): Promise<void> {
    if (!code) throw new AppError(400, 'MISSING_CODE', 'Authorization code is required');
    const t = await this.tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: this.o.redirectUri });
    if (!t.refresh_token && !user.calendar.encryptedRefreshToken)
      throw new AppError(400, 'NO_REFRESH_TOKEN', 'Google did not return a refresh token. Remove the app from your Google account permissions and reconnect.');
    const email = t.id_token ? (JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()) as { email?: string }).email : undefined;
    user.calendar = {
      connected: true,
      provider: 'google',
      accountEmail: email ?? user.email,
      connectedAt: this.now(),
      scopes: (t.scope ?? '').split(' ').filter(Boolean),
      encryptedAccessToken: encrypt(t.access_token, this.o.encryptionKey),
      encryptedRefreshToken: t.refresh_token ? encrypt(t.refresh_token, this.o.encryptionKey) : user.calendar.encryptedRefreshToken,
      tokenExpiry: this.now() + t.expires_in * 1000,
    };
  }

  async disconnect(user: User): Promise<void> {
    const enc = user.calendar.encryptedRefreshToken ?? user.calendar.encryptedAccessToken;
    if (enc) {
      try {
        await this.f('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: decrypt(enc, this.o.encryptionKey) }),
        });
      } catch {
        /* revoke is best-effort; local credentials are removed regardless */
      }
    }
    user.calendar = { connected: false, provider: 'google' };
  }

  private async accessToken(user: User): Promise<string> {
    const c = user.calendar;
    if (!c.connected || !c.encryptedRefreshToken) throw new CalendarDisconnectedError();
    if (c.encryptedAccessToken && c.tokenExpiry && c.tokenExpiry - this.now() > 60_000) return decrypt(c.encryptedAccessToken, this.o.encryptionKey);
    try {
      const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(c.encryptedRefreshToken, this.o.encryptionKey) });
      c.encryptedAccessToken = encrypt(t.access_token, this.o.encryptionKey);
      c.tokenExpiry = this.now() + t.expires_in * 1000;
      return t.access_token;
    } catch (e) {
      if (e instanceof CalendarDisconnectedError) user.calendar = { connected: false, provider: 'google' };
      throw e;
    }
  }

  /** Authorized request with exponential backoff on 429 / 5xx / rate-limit 403. */
  private async api(user: User, path: string, init: RequestInit = {}, attempts = 4): Promise<Response> {
    const token = await this.accessToken(user);
    for (let i = 0; ; i++) {
      const res = await this.f(`${API}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || i >= attempts - 1) {
        if (res.status === 401) throw new CalendarDisconnectedError();
        return res;
      }
      await this.sleep(2 ** i * 500 + Math.floor(Math.random() * 100));
    }
  }

  async freeBusy(user: User, emails: string[], startMs: number, endMs: number, _tz?: string): Promise<Record<string, FreeBusyResult>> {
    const res = await this.api(user, '/freeBusy', {
      method: 'POST',
      body: JSON.stringify({ timeMin: new Date(startMs).toISOString(), timeMax: new Date(endMs).toISOString(), items: emails.map((id) => ({ id })) }),
    });
    if (!res.ok) throw new AppError(502, 'GOOGLE_API_FAILURE', `Google FreeBusy failed (${res.status})`);
    const data = (await res.json()) as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> };
    const out: Record<string, FreeBusyResult> = {};
    for (const email of emails) {
      const cal = data.calendars?.[email];
      if (!cal) out[email] = { error: 'unavailable' };
      else if (cal.errors?.length) out[email] = { error: cal.errors[0].reason === 'notFound' ? 'notFound' : 'forbidden' };
      else out[email] = { busy: (cal.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })) };
    }
    return out;
  }

  async listEvents(user: User, fromMs: number, toMs: number, _tz?: string): Promise<CalendarEvent[]> {
    const q = new URLSearchParams({ timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '100' });
    const res = await this.api(user, `/calendars/primary/events?${q}`);
    if (!res.ok) throw new AppError(502, 'GOOGLE_API_FAILURE', `Google events list failed (${res.status})`);
    const data = (await res.json()) as { items?: GoogleEvent[] };
    return (data.items ?? []).filter((e) => e.start?.dateTime && e.status !== 'cancelled').map(mapEvent);
  }

  async createEvent(user: User, input: CreateEventInput): Promise<CreatedEvent> {
    // Google event ids must be base32hex (a-v, 0-9) and 5-1024 chars; a hex digest qualifies.
    const id = input.idempotencyKey.toLowerCase().replace(/[^0-9a-v]/g, '').padEnd(5, '0');
    const body: Record<string, unknown> = {
      id,
      summary: input.title,
      description: input.description,
      location: input.location || undefined,
      start: { dateTime: new Date(input.startUtc).toISOString(), timeZone: input.timezone },
      end: { dateTime: new Date(input.endUtc).toISOString(), timeZone: input.timezone },
      attendees: input.attendees.map((a) => ({ email: a.email, displayName: a.name, optional: a.optional })),
    };
    if (input.addMeet) body.conferenceData = { createRequest: { requestId: id, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    const res = await this.api(user, `/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1`, { method: 'POST', body: JSON.stringify(body) });
    if (res.status === 409) {
      const existing = await this.api(user, `/calendars/primary/events/${id}`);
      if (existing.ok) return toCreated((await existing.json()) as GoogleEvent);
    }
    if (!res.ok) throw new AppError(502, 'EVENT_CREATION_FAILED', `Google event creation failed (${res.status})`);
    return toCreated((await res.json()) as GoogleEvent);
  }
}

interface GoogleEvent {
  id: string;
  summary?: string;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  location?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  attendees?: { email: string }[];
}
const toCreated = (e: GoogleEvent): CreatedEvent => ({ id: e.id, htmlLink: e.htmlLink, meetLink: e.hangoutLink });
const mapEvent = (e: GoogleEvent): CalendarEvent => ({
  id: e.id,
  title: e.summary ?? '(no title)',
  startUtc: Date.parse(e.start!.dateTime!),
  endUtc: Date.parse(e.end!.dateTime!),
  attendees: (e.attendees ?? []).map((a) => a.email),
  htmlLink: e.htmlLink,
  meetLink: e.hangoutLink,
  location: e.location,
});
