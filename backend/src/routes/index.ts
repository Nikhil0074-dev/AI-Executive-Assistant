import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { GoogleCalendarProvider } from '../calendar/googleProvider';
import { newId } from '../store';
import type { Participant, User } from '../types';
import { AppError } from '../utils/errors';
import { isValidTimeZone, localMs, addDays, localDateOf } from '../utils/timezone';
import type { Deps } from '../services/deps';
import { InvitationService } from '../services/invitations';
import { SchedulingService } from '../services/scheduling';

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

const email = z.string().trim().toLowerCase().email('Enter a valid email address');
const tzSchema = z.string().refine(isValidTimeZone, 'Unknown time zone');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const registerSchema = z.object({ name: z.string().trim().min(1).max(80), email, password: z.string().min(8, 'Password must be at least 8 characters').max(200), timezone: tzSchema.default('UTC') });
const loginSchema = z.object({ email, password: z.string().min(1) });
const participantSchema = z.object({ name: z.string().trim().min(1).max(80), email, timezone: tzSchema.optional(), required: z.boolean().default(true) });
const prefSchema = z
  .object({ timezone: tzSchema.optional(), workingStart: hhmm.optional(), workingEnd: hhmm.optional(), workingDays: z.array(z.number().int().min(0).max(6)).min(1).optional() })
  .strict()
  .refine((p) => !p.workingStart || !p.workingEnd || p.workingStart < p.workingEnd, 'Working hours must end after they start');

export const DEMO_PARTICIPANTS = [
  { name: 'Sarah Chen', email: 'sarah@example.com', timezone: 'Europe/London' },
  { name: 'Alex Rivera', email: 'alex@example.com', timezone: 'Asia/Kolkata' },
  { name: 'Priya Nair', email: 'priya@example.com', timezone: 'Asia/Kolkata' },
  { name: 'John Miller', email: 'john@example.com', timezone: 'America/New_York' },
];

export const publicUser = (u: User) => ({
  id: u.id, name: u.name, email: u.email, timezone: u.timezone, workingHours: u.workingHours,
  calendar: { connected: u.calendar.connected, provider: u.calendar.provider, accountEmail: u.calendar.accountEmail, connectedAt: u.calendar.connectedAt },
});

export function createRouter(d: Deps, opts: { seedDemo: boolean }) {
  const { store, config, calendar } = d;
  const scheduling = new SchedulingService(d);
  const invitations = new InvitationService(d, scheduling);
  const r = Router();
  r.use(express.json({ limit: '100kb' }), cookieParser());

  const issue = (res: Response, u: User) =>
    res.cookie('token', jwt.sign({ sub: u.id }, config.jwtSecret, { expiresIn: '7d' }), { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 7 * 86400_000 });

  const auth = (req: Request, _res: Response, next: NextFunction) => {
    try {
      const { sub } = jwt.verify(req.cookies?.token ?? '', config.jwtSecret) as { sub: string };
      const user = store.users.get(sub);
      if (!user) throw new Error('no user');
      req.user = user;
      next();
    } catch {
      next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue'));
    }
  };

  const limiter = config.rateLimit ? rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } } }) : (_q: Request, _s: Response, n: NextFunction) => n();

  // ---- auth ---------------------------------------------------------------
  r.post('/auth/register', limiter, async (req, res) => {
    const b = registerSchema.parse(req.body);
    if (store.userByEmail(b.email)) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    const user: User = {
      id: newId('usr'), name: b.name, email: b.email, passwordHash: await bcrypt.hash(b.password, 10), timezone: b.timezone,
      workingHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }, calendar: { connected: false, provider: calendar.mode }, createdAt: d.now(),
    };
    store.users.set(user.id, user);
    if (opts.seedDemo) for (const p of DEMO_PARTICIPANTS) { const id = newId('par'); store.participants.set(id, { id, ownerId: user.id, required: true, createdAt: d.now(), ...p }); }
    store.log(user.id, 'auth.register', 'user', user.id);
    issue(res, user);
    res.status(201).json({ user: publicUser(user) });
  });
  r.post('/auth/login', limiter, async (req, res) => {
    const b = loginSchema.parse(req.body);
    const user = store.userByEmail(b.email);
    const ok = user ? await bcrypt.compare(b.password, user.passwordHash) : await bcrypt.compare(b.password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
    if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    store.log(user.id, 'auth.login', 'user', user.id);
    issue(res, user);
    res.json({ user: publicUser(user) });
  });
  r.post('/auth/logout', (_req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
  r.get('/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user!) }));

  // ---- calendar connection ----------------------------------------------------
  r.get('/calendar/status', auth, (req, res) => res.json({ ...publicUser(req.user!).calendar, mode: calendar.mode }));
  r.post('/calendar/connect', auth, async (req, res) => {
    const url = calendar.authUrl(req.user!);
    if (url) return res.json({ redirectUrl: url, connected: false });
    await calendar.connect(req.user!);
    store.log(req.user!.id, 'calendar.connect', 'user', req.user!.id);
    res.json({ ...publicUser(req.user!).calendar });
  });
  r.get('/auth/google', auth, async (req, res) => {
    const url = calendar.authUrl(req.user!);
    if (!url) { await calendar.connect(req.user!); return res.redirect('/'); }
    res.redirect(url);
  });
  r.get('/auth/google/callback', auth, async (req, res) => {
    if (!(calendar instanceof GoogleCalendarProvider)) throw new AppError(400, 'NOT_CONFIGURED', 'Google OAuth is not configured');
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) return res.redirect(`${config.appUrl}/?calendar=denied`);
    if (!state || !calendar.verifyState(state, req.user!.id)) throw new AppError(400, 'INVALID_STATE', 'OAuth state is invalid or expired');
    await calendar.connect(req.user!, code);
    store.log(req.user!.id, 'calendar.connect', 'user', req.user!.id);
    res.redirect(`${config.appUrl}/?calendar=connected`);
  });
  const disconnect = async (req: Request, res: Response) => {
    await calendar.disconnect(req.user!);
    store.log(req.user!.id, 'calendar.disconnect', 'user', req.user!.id);
    res.json({ connected: false });
  };
  r.delete('/auth/google/disconnect', auth, disconnect);
  r.delete('/calendar/connection', auth, disconnect);
  r.post('/calendar/freebusy', auth, async (req, res) => {
    const b = z.object({ emails: z.array(email).min(1).max(20), start: z.string().datetime(), end: z.string().datetime() }).parse(req.body);
    if (!req.user!.calendar.connected) throw new AppError(409, 'CALENDAR_DISCONNECTED', 'Connect Google Calendar first');
    res.json({ calendars: await calendar.freeBusy(req.user!, b.emails, Date.parse(b.start), Date.parse(b.end), req.user!.timezone) });
  });

  // ---- meetings (dashboard) ---------------------------------------------------
  r.get('/meetings', auth, async (req, res) => {
    const u = req.user!;
    if (!u.calendar.connected) return res.json({ today: [], upcoming: [], connected: false });
    const today = localDateOf(d.now(), u.timezone);
    const from = localMs(today, 0, u.timezone);
    const endToday = localMs(addDays(today, 1), 0, u.timezone);
    const endWeek = localMs(addDays(today, 8), 0, u.timezone);
    try {
      const events = await calendar.listEvents(u, from, endWeek, u.timezone);
      res.json({
        connected: true,
        today: events.filter((e) => e.startUtc < endToday),
        upcoming: events.filter((e) => e.startUtc >= endToday).slice(0, 12),
      });
    } catch {
      res.json({ connected: true, today: [], upcoming: [], warning: 'Could not load meetings from Google Calendar' });
    }
  });

  // ---- participants ----------------------------------------------------------------
  r.get('/participants', auth, (req, res) => {
    const q = String(req.query.q ?? '').toLowerCase();
    const list = store.participantsOf(req.user!.id).filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.includes(q));
    res.json({ participants: list.sort((a, b) => a.name.localeCompare(b.name)) });
  });
  r.post('/participants', auth, (req, res) => {
    const b = participantSchema.parse(req.body);
    const dup = store.participantsOf(req.user!.id).find((p) => p.email === b.email);
    if (dup) throw new AppError(409, 'DUPLICATE_PARTICIPANT', `${dup.name} is already saved with this email`, { existing: dup });
    const p: Participant = { id: newId('par'), ownerId: req.user!.id, createdAt: d.now(), ...b };
    store.participants.set(p.id, p);
    res.status(201).json({ participant: p });
  });
  const ownedParticipant = (req: Request) => {
    const p = store.participants.get(String(req.params.id));
    if (!p || p.ownerId !== req.user!.id) throw new AppError(404, 'NOT_FOUND', 'Participant not found');
    return p;
  };
  r.patch('/participants/:id', auth, (req, res) => {
    const p = ownedParticipant(req);
    const b = participantSchema.partial().parse(req.body);
    if (b.email && b.email !== p.email && store.participantsOf(req.user!.id).some((x) => x.email === b.email)) throw new AppError(409, 'DUPLICATE_PARTICIPANT', 'Another participant already uses this email');
    Object.assign(p, b);
    res.json({ participant: p });
  });
  r.delete('/participants/:id', auth, (req, res) => { store.participants.delete(ownedParticipant(req).id); res.json({ ok: true }); });

  // ---- preferences ----------------------------------------------------------------------
  r.get('/preferences', auth, (req, res) => res.json({ timezone: req.user!.timezone, workingHours: req.user!.workingHours }));
  r.patch('/preferences', auth, (req, res) => {
    const b = prefSchema.parse(req.body);
    const u = req.user!;
    const next = { start: b.workingStart ?? u.workingHours.start, end: b.workingEnd ?? u.workingHours.end };
    if (next.start >= next.end) throw new AppError(400, 'VALIDATION_ERROR', 'Working hours must end after they start');
    if (b.timezone) u.timezone = b.timezone;
    u.workingHours = { ...next, days: b.workingDays ?? u.workingHours.days };
    res.json({ timezone: u.timezone, workingHours: u.workingHours });
  });

  // ---- scheduling ---------------------------------------------------------------------------
  r.post('/scheduling/request', auth, async (req, res) => {
    res.json({ request: strip(await scheduling.create(req.user!, req.body)) });
  });
  r.post('/scheduling/parse', auth, async (req, res) => {
    const { prompt } = z.object({ prompt: z.string().trim().min(3).max(1000) }).parse(req.body);
    res.json(await d.parse(prompt, { nowMs: d.now(), tz: req.user!.timezone }));
  });
  r.get('/scheduling/history', auth, (req, res) => {
    const list = [...store.requests.values()].filter((q) => q.userId === req.user!.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
    res.json({ history: list.map((q) => ({ id: q.id, prompt: q.prompt, status: q.status, createdAt: q.createdAt, slots: q.slots.length })) });
  });
  r.get('/scheduling/:id', auth, (req, res) => res.json({ request: strip(scheduling.owned(req.user!, String(req.params.id))) }));
  r.post('/scheduling/:id/retry', auth, async (req, res) => res.json({ request: strip(await scheduling.retry(req.user!, String(req.params.id))) }));

  // ---- invitations ----------------------------------------------------------------------------
  r.get('/invitations', auth, (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    const list = [...store.drafts.values()].filter((x) => x.userId === req.user!.id && (!status || x.status === status)).sort((a, b) => b.createdAt - a.createdAt);
    res.json({ invitations: list.map(({ userId: _u, ...rest }) => rest) });
  });
  r.post('/invitations/draft', auth, (req, res) => {
    const b = z.object({ requestId: z.string(), slotId: z.string() }).parse(req.body);
    res.status(201).json({ invitation: draftOut(invitations.create(req.user!, b.requestId, b.slotId)) });
  });
  r.get('/invitations/:id', auth, (req, res) => res.json({ invitation: draftOut(invitations.owned(req.user!, String(req.params.id))) }));
  r.patch('/invitations/:id', auth, (req, res) => res.json({ invitation: draftOut(invitations.update(req.user!, String(req.params.id), req.body)) }));
  r.post('/invitations/:id/confirm', auth, async (req, res) => {
    const b = z.object({ acknowledgeUnverified: z.boolean().default(false) }).parse(req.body ?? {});
    res.json({ invitation: draftOut(await invitations.confirm(req.user!, String(req.params.id), b.acknowledgeUnverified)) });
  });
  r.post('/invitations/:id/cancel', auth, (req, res) => res.json({ invitation: draftOut(invitations.cancel(req.user!, String(req.params.id))) }));

  return r;
}

const strip = <T extends { userId: string }>({ userId: _u, ...rest }: T) => rest;
const draftOut = strip;

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  if (err instanceof z.ZodError) return void res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.issues[0]?.message ?? 'Invalid input', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  if ((err as { type?: string }).type === 'entity.parse.failed') return void res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
