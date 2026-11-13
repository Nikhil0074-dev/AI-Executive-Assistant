import { describe, it, expect, vi } from 'vitest';
import { GoogleCalendarProvider } from '../src/calendar/googleProvider';
import { decrypt } from '../src/utils/crypto';
import { AppError, CalendarDisconnectedError } from '../src/utils/errors';
import type { User } from '../src/types';

const KEY = 'ab'.repeat(32);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const mkUser = (): User => ({ id: 'u1', email: 'me@x.com', calendar: { connected: false, provider: 'google' } }) as User;
const idToken = 'h.' + Buffer.from(JSON.stringify({ email: 'me@gmail.com' })).toString('base64url') + '.s';

function make(handler: (url: string, init: RequestInit) => Response | Promise<Response>, now = () => 1_000_000) {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
  const sleep = vi.fn(async () => {});
  const p = new GoogleCalendarProvider({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://app/cb', encryptionKey: KEY, stateSecret: 's'.repeat(32), fetchImpl: fetchImpl as never, sleep, now });
  return { p, fetchImpl, sleep };
}
const connected = (over: Partial<User['calendar']> = {}): User => {
  const u = mkUser();
  return Object.assign(u, { calendar: { connected: true, provider: 'google', encryptedRefreshToken: undefined, ...over } });
};

async function connectedUser() {
  const { p, fetchImpl, sleep } = make((url) => {
    if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, id_token: idToken, scope: 'openid email calendar.events' });
    return json({});
  });
  const u = mkUser();
  await p.connect(u, 'code123');
  return { p, u, fetchImpl, sleep };
}

describe('GoogleCalendarProvider', () => {
  it('builds a consent URL with least-privilege scopes, offline access and signed state', () => {
    const { p } = make(() => json({}));
    const u = mkUser();
    const url = new URL(p.authUrl(u));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    const scope = url.searchParams.get('scope')!;
    expect(scope).toContain('calendar.freebusy');
    expect(scope).toContain('calendar.events');
    expect(scope).not.toMatch(/auth\/calendar(\s|$)/); // no full-calendar scope
    const state = url.searchParams.get('state')!;
    expect(p.verifyState(state, u.id)).toBe(true);
    expect(p.verifyState(state, 'other-user')).toBe(false);
    expect(p.verifyState('garbage', u.id)).toBe(false);
  });

  it('exchanges the code and stores encrypted tokens only', async () => {
    const { u } = await connectedUser();
    expect(u.calendar.connected).toBe(true);
    expect(u.calendar.accountEmail).toBe('me@gmail.com');
    expect(JSON.stringify(u.calendar)).not.toContain('"RT"');
    expect(decrypt(u.calendar.encryptedRefreshToken!, KEY)).toBe('RT');
    expect(decrypt(u.calendar.encryptedAccessToken!, KEY)).toBe('AT');
  });

  it('requires an authorization code', async () => {
    await expect(make(() => json({})).p.connect(mkUser())).rejects.toMatchObject({ code: 'MISSING_CODE' });
  });

  it('maps FreeBusy results, including inaccessible and unknown calendars', async () => {
    const { p, u, fetchImpl } = await connectedUser();
    fetchImpl.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer AT');
      const body = JSON.parse(init!.body as string);
      expect(body.items).toEqual([{ id: 'a@x.com' }, { id: 'b@x.com' }, { id: 'c@x.com' }, { id: 'd@x.com' }]);
      return json({ calendars: {
        'a@x.com': { busy: [{ start: '2026-11-10T10:00:00Z', end: '2026-11-10T11:00:00Z' }] },
        'b@x.com': { errors: [{ reason: 'notFound' }] },
        'c@x.com': { errors: [{ reason: 'forbidden' }] },
      } });
    });
    const r = await p.freeBusy(u, ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'], 0, 1, 'UTC');
    expect(r['a@x.com']).toEqual({ busy: [{ start: Date.parse('2026-11-10T10:00:00Z'), end: Date.parse('2026-11-10T11:00:00Z') }] });
    expect(r['b@x.com']).toEqual({ error: 'notFound' });
    expect(r['c@x.com']).toEqual({ error: 'forbidden' });
    expect(r['d@x.com']).toEqual({ error: 'unavailable' });
  });

  it('creates events with attendees, sendUpdates and a Meet request', async () => {
    const { p, u, fetchImpl } = await connectedUser();
    let captured: { url: string; body: Record<string, any> } | undefined;
    fetchImpl.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(init!.body as string) };
      return json({ id: captured.body.id, htmlLink: 'https://cal/e', hangoutLink: 'https://meet.google.com/abc' });
    });
    const r = await p.createEvent(u, {
      idempotencyKey: 'deadbeef12', title: 'Sync', description: 'D', location: '', startUtc: 1_700_000_000_000, endUtc: 1_700_000_900_000,
      timezone: 'Asia/Kolkata', attendees: [{ email: 's@x.com', name: 'Sarah', optional: false }, { email: 'o@x.com', optional: true }], addMeet: true,
    });
    expect(r).toEqual({ id: 'deadbeef12', htmlLink: 'https://cal/e', meetLink: 'https://meet.google.com/abc' });
    expect(captured!.url).toContain('sendUpdates=all');
    expect(captured!.url).toContain('conferenceDataVersion=1');
    expect(captured!.body.id).toMatch(/^[0-9a-v]{5,}$/);
    expect(captured!.body.attendees).toEqual([{ email: 's@x.com', displayName: 'Sarah', optional: false }, { email: 'o@x.com', optional: true }]);
    expect(captured!.body.conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet');
    expect(captured!.body.start).toEqual({ dateTime: new Date(1_700_000_000_000).toISOString(), timeZone: 'Asia/Kolkata' });
  });

  it('omits conference data when Meet is not requested', async () => {
    const { p, u, fetchImpl } = await connectedUser();
    let body: Record<string, unknown> = {};
    fetchImpl.mockImplementation(async (_u: string | URL | Request, init?: RequestInit) => { body = JSON.parse(init!.body as string); return json({ id: 'x' }); });
    await p.createEvent(u, { idempotencyKey: 'abcde', title: 'T', description: '', location: 'Room 1', startUtc: 0, endUtc: 60000, timezone: 'UTC', attendees: [], addMeet: false });
    expect(body.conferenceData).toBeUndefined();
    expect(body.location).toBe('Room 1');
  });

  it('returns the existing event when Google reports a duplicate id (idempotent retry)', async () => {
    const { p, u, fetchImpl } = await connectedUser();
    fetchImpl.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ error: 'duplicate' }, 409);
      expect(String(url)).toContain('/events/abcde');
      return json({ id: 'abcde', htmlLink: 'https://cal/existing' });
    });
    const r = await p.createEvent(u, { idempotencyKey: 'abcde', title: 'T', description: '', location: '', startUtc: 0, endUtc: 60000, timezone: 'UTC', attendees: [], addMeet: false });
    expect(r.htmlLink).toBe('https://cal/existing');
  });

  it('lists events and skips all-day/cancelled ones', async () => {
    const { p, u, fetchImpl } = await connectedUser();
    fetchImpl.mockImplementation(async () => json({ items: [
      { id: '1', summary: 'A', start: { dateTime: '2026-11-10T10:00:00Z' }, end: { dateTime: '2026-11-10T11:00:00Z' }, attendees: [{ email: 'x@x.com' }] },
      { id: '2', summary: 'All day', start: { date: '2026-11-10' }, end: { date: '2026-11-11' } },
      { id: '3', status: 'cancelled', start: { dateTime: '2026-11-10T10:00:00Z' }, end: { dateTime: '2026-11-10T11:00:00Z' } },
    ] }));
    const ev = await p.listEvents(u, 0, 1);
    expect(ev.map((e) => e.id)).toEqual(['1']);
    expect(ev[0].attendees).toEqual(['x@x.com']);
  });

  it('retries 429/5xx with exponential backoff and then succeeds', async () => {
    const { p, u, fetchImpl, sleep } = await connectedUser();
    let n = 0;
    fetchImpl.mockImplementation(async () => (++n < 3 ? json({}, n === 1 ? 429 : 503) : json({ calendars: { 'a@x.com': { busy: [] } } })));
    const r = await p.freeBusy(u, ['a@x.com'], 0, 1, 'UTC');
    expect(r['a@x.com']).toEqual({ busy: [] });
    expect(n).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const [first, second] = sleep.mock.calls.map((c) => (c as unknown as [number])[0]);
    expect(second).toBeGreaterThan(first);
  });

  it('gives up after repeated failures with a GOOGLE_API_FAILURE error', async () => {
    const { p, u, fetchImpl } = await connectedUser();
    fetchImpl.mockImplementation(async () => json({}, 500));
    await expect(p.freeBusy(u, ['a@x.com'], 0, 1, 'UTC')).rejects.toMatchObject({ code: 'GOOGLE_API_FAILURE' });
  });

  it('refreshes an expired access token', async () => {
    let t = 1_000_000;
    const { p, fetchImpl } = make((url) => {
      if (url.includes('/token')) return json({ access_token: 'AT2', refresh_token: 'RT', expires_in: 3600, id_token: idToken });
      return json({});
    }, () => t);
    const u = mkUser();
    await p.connect(u, 'c');
    t += 2 * 3600 * 1000;
    fetchImpl.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/token')) {
        expect(String(init!.body)).toContain('grant_type=refresh_token');
        return json({ access_token: 'AT3', expires_in: 3600 });
      }
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer AT3');
      return json({ calendars: {} });
    });
    await p.freeBusy(u, ['a@x.com'], 0, 1, 'UTC');
    expect(decrypt(u.calendar.encryptedAccessToken!, KEY)).toBe('AT3');
  });

  it('marks the user disconnected when Google revokes access (invalid_grant)', async () => {
    const { p, u, fetchImpl } = await connectedUser();
    u.calendar.tokenExpiry = 0;
    fetchImpl.mockImplementation(async () => json({ error: 'invalid_grant' }, 400));
    await expect(p.freeBusy(u, ['a@x.com'], 0, 1, 'UTC')).rejects.toBeInstanceOf(CalendarDisconnectedError);
    expect(u.calendar.connected).toBe(false);
  });

  it('throws CalendarDisconnectedError when never connected', async () => {
    await expect(make(() => json({})).p.freeBusy(connected(), ['a@x.com'], 0, 1, 'UTC')).rejects.toBeInstanceOf(CalendarDisconnectedError);
  });

  it('disconnect revokes the token and wipes credentials even if revoke fails', async () => {
    const { p, u, fetchImpl } = await connectedUser();
    let revoked = '';
    fetchImpl.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/revoke');
      revoked = String(init!.body);
      throw new Error('network down');
    });
    await p.disconnect(u);
    expect(revoked).toContain('token=RT');
    expect(u.calendar).toEqual({ connected: false, provider: 'google' });
  });

  it('surfaces non-retryable API errors as AppError', async () => {
    const { p, u, fetchImpl } = await connectedUser();
    fetchImpl.mockImplementation(async () => json({}, 403));
    await expect(p.createEvent(u, { idempotencyKey: 'abcde', title: 'T', description: '', location: '', startUtc: 0, endUtc: 60000, timezone: 'UTC', attendees: [], addMeet: false })).rejects.toBeInstanceOf(AppError);
  });
});
