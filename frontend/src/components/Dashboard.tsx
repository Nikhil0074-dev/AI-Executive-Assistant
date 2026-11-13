import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtDay, fmtRange, fmtTime } from '../lib/time';
import type { CalEvent, Invitation, User } from '../lib/types';

interface Hist { id: string; prompt: string; status: string; createdAt: number; slots: number }
const STATUS: Record<string, string> = { ready: 'Times found', needs_clarification: 'Waiting for details', no_availability: 'No common time', failed: 'Failed', booked: 'Booked' };

export default function Dashboard({ user, version, onResume, onDisconnect, onConnect }: { user: User; version: number; onResume: (id: string) => void; onDisconnect: () => void; onConnect: () => void }) {
  const [today, setToday] = useState<CalEvent[]>([]);
  const [upcoming, setUpcoming] = useState<CalEvent[]>([]);
  const [drafts, setDrafts] = useState<Invitation[]>([]);
  const [history, setHistory] = useState<Hist[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [m, d, f, h] = await Promise.all([
      api('GET', '/meetings'), api('GET', '/invitations?status=awaiting_confirmation'), api('GET', '/invitations?status=failed'), api('GET', '/scheduling/history'),
    ]);
    setToday(m.today); setUpcoming(m.upcoming); setDrafts([...d.invitations, ...f.invitations]); setHistory(h.history); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load, version, user.calendar.connected]);

  async function discard(id: string) { await api('POST', `/invitations/${id}/cancel`); void load(); }
  const tz = user.timezone;
  const c = user.calendar;

  return (
    <div className="dash">
      <section className="card profile">
        <h2>{user.name}</h2>
        <p className="muted">{user.email}</p>
        <dl className="facts">
          <dt>Time zone</dt><dd>{tz}</dd>
          <dt>Working hours</dt><dd>{user.workingHours.start}–{user.workingHours.end}, {user.workingHours.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(' ')}</dd>
          <dt>Google Calendar</dt>
          <dd>{c.connected ? <><span className="dot ok" /> Connected{c.accountEmail ? ` as ${c.accountEmail}` : ''}{c.provider === 'mock' && <small className="muted"> (demo data)</small>}</> : <><span className="dot off" /> Not connected</>}</dd>
        </dl>
        {c.connected ? <button className="btn" onClick={onDisconnect}>Disconnect Google Calendar</button> : <button className="btn primary" onClick={onConnect}>Connect Google Calendar</button>}
      </section>

      <section className="card">
        <h2>Today</h2>
        {!c.connected ? <p className="muted">Connect Google Calendar to see today's meetings.</p>
          : today.length === 0 ? <p className="muted">{loaded ? 'No meetings left today.' : 'Loading…'}</p>
          : <ul className="events">{today.map((e) => <li key={e.id}><time>{fmtTime(e.startUtc, tz)}</time><span>{e.title}</span></li>)}</ul>}
      </section>

      <section className="card">
        <h2>Upcoming</h2>
        {!c.connected ? <p className="muted">Nothing to show yet.</p>
          : upcoming.length === 0 ? <p className="muted">{loaded ? 'No meetings in the next 7 days.' : 'Loading…'}</p>
          : <ul className="events">{upcoming.map((e) => <li key={e.id}><time>{fmtDay(e.startUtc, tz)}<br />{fmtRange(e.startUtc, e.endUtc, tz)}</time><span>{e.title}</span></li>)}</ul>}
      </section>

      <section className="card">
        <h2>Pending invitations</h2>
        {drafts.length === 0 ? <p className="muted">No drafts waiting for your confirmation.</p> : (
          <ul className="events">
            {drafts.map((d) => (
              <li key={d.id}>
                <time>{fmtDay(d.startUtc, tz)}<br />{fmtTime(d.startUtc, tz)}</time>
                <span>{d.title}{d.status === 'failed' && <em className="bad"> failed, retry available</em>}</span>
                <span className="row-actions"><button className="link" onClick={() => onResume(d.id)}>Review</button><button className="link" onClick={() => discard(d.id)}>Discard</button></span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card wide">
        <h2>Scheduling history</h2>
        {history.length === 0 ? <p className="muted">Your requests will appear here.</p> : (
          <ul className="events">
            {history.map((h) => <li key={h.id}><time>{fmtDay(h.createdAt, tz)}</time><span>{h.prompt}</span><span className={`status ${h.status}`}>{STATUS[h.status] ?? h.status}</span></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
