import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { fmtDay, fmtFull } from '../lib/time';
import type { Answers, Invitation, SchedulingRequest, User } from '../lib/types';
import Clarify from './Clarify';
import InvitationPanel from './InvitationPanel';
import SlotCard from './SlotCard';

type Msg =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'text'; text: string; tone?: 'error' | 'info' }
  | { id: number; kind: 'request'; prompt: string; request: SchedulingRequest }
  | { id: number; kind: 'draft'; draft: Invitation }
  | { id: number; kind: 'created'; draft: Invitation };

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const EXAMPLES = [
  'Find 45 minutes next week for me, Sarah, and Alex after 2 PM. Avoid Friday.',
  'Arrange a 30-minute meeting with John and Priya next Tuesday.',
  'Schedule a project review with Sarah before Friday, one hour, with a Google Meet link.',
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Assistant({ user, resumeDraft, onResumed, onChanged }: { user: User; resumeDraft: string | null; onResumed: () => void; onChanged: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(1);
  const end = useRef<HTMLDivElement>(null);
  const push = (m: DistOmit<Msg, 'id'>) => setMsgs((x) => [...x, { ...m, id: seq.current++ } as Msg]);
  const replace = (id: number, fn: (m: Msg) => Msg | null) => setMsgs((x) => x.flatMap((m) => (m.id === id ? (fn(m) ? [fn(m)!] : []) : [m])));

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs]);

  useEffect(() => {
    if (!resumeDraft) return;
    api<{ invitation: Invitation }>('GET', `/invitations/${resumeDraft}`)
      .then((r) => push({ kind: 'draft', draft: r.invitation }))
      .catch(() => push({ kind: 'text', tone: 'error', text: 'That draft could not be opened.' }))
      .finally(onResumed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeDraft]);

  async function run(prompt: string, answers?: Answers, requestId?: string, replaceId?: number) {
    setBusy(true);
    try {
      const r = await api<{ request: SchedulingRequest }>('POST', '/scheduling/request', { prompt, answers, requestId });
      if (replaceId) replace(replaceId, (m) => ({ ...(m as Msg & { kind: 'request' }), request: r.request }));
      else push({ kind: 'request', prompt, request: r.request });
      onChanged();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Could not reach the server.';
      push({ kind: 'text', tone: 'error', text: e instanceof ApiError && e.code === 'GOOGLE_API_FAILURE' ? `${msg}` : msg });
    } finally {
      setBusy(false);
    }
  }

  function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setInput('');
    push({ kind: 'user', text: t });
    void run(t);
  }

  async function choose(request: SchedulingRequest, slotId: string) {
    setBusy(true);
    try {
      const r = await api<{ invitation: Invitation }>('POST', '/invitations/draft', { requestId: request.id, slotId });
      push({ kind: 'draft', draft: r.invitation });
      onChanged();
    } catch (e) {
      push({ kind: 'text', tone: 'error', text: e instanceof ApiError ? e.message : 'Could not prepare the invitation.' });
    } finally {
      setBusy(false);
    }
  }

  async function retry(msgId: number, request: SchedulingRequest) {
    setBusy(true);
    try {
      const r = await api<{ request: SchedulingRequest }>('POST', `/scheduling/${request.id}/retry`);
      replace(msgId, (m) => ({ ...(m as Msg & { kind: 'request' }), request: r.request }));
    } catch (e) {
      push({ kind: 'text', tone: 'error', text: e instanceof ApiError ? e.message : 'Retry failed.' });
    } finally {
      setBusy(false);
    }
  }

  async function conflict(requestId: string, message: string, draftMsgId: number) {
    replace(draftMsgId, () => null);
    push({ kind: 'text', tone: 'error', text: message });
    try {
      const r = await api<{ request: SchedulingRequest }>('GET', `/scheduling/${requestId}`);
      push({ kind: 'request', prompt: r.request.prompt, request: r.request });
    } catch { /* the message above already explains the next step */ }
  }

  return (
    <div className="assistant">
      <div className="thread" aria-live="polite">
        {msgs.length === 0 && (
          <div className="empty">
            <h2>What should we schedule?</h2>
            <p>Include who, how long, and when. I will ask about anything missing.</p>
            <div className="examples">
              {EXAMPLES.map((e) => <button key={e} className="example" onClick={() => send(e)}>{e}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m) => {
          switch (m.kind) {
            case 'user':
              return <div key={m.id} className="bubble user">{m.text}</div>;
            case 'text':
              return <div key={m.id} className={`bubble bot ${m.tone ?? ''}`} role={m.tone === 'error' ? 'alert' : undefined}>{m.text}</div>;
            case 'request':
              return <RequestView key={m.id} request={m.request} user={user} busy={busy}
                onAnswer={(a) => run(m.prompt, a, m.request.id, m.id)} onSelect={(id) => choose(m.request, id)} onRetry={() => retry(m.id, m.request)} />;
            case 'draft':
              return <InvitationPanel key={m.id} draft={m.draft} organizer={`${user.name} (${user.email})`}
                onChange={(d) => replace(m.id, () => ({ ...m, draft: d }))}
                onCreated={(d) => { replace(m.id, () => ({ id: m.id, kind: 'created', draft: d })); onChanged(); }}
                onBack={() => { replace(m.id, () => null); onChanged(); }}
                onConflict={(rid, text) => conflict(rid, text, m.id)} />;
            case 'created':
              return (
                <section key={m.id} className="card success" role="status">
                  <h3>Invitation sent</h3>
                  <p><strong>{m.draft.title}</strong><br />{fmtFull(m.draft.startUtc, m.draft.timezone)}</p>
                  <p className="muted">Sent to {m.draft.attendees.map((a) => a.name).join(', ') || 'you'}.</p>
                  <div className="actions">
                    {m.draft.htmlLink && <a className="btn" href={m.draft.htmlLink} target="_blank" rel="noreferrer">Open in Google Calendar</a>}
                    {m.draft.meetLink && <a className="btn" href={m.draft.meetLink} target="_blank" rel="noreferrer">Join with Google Meet</a>}
                  </div>
                </section>
              );
          }
        })}
        {busy && <div className="bubble bot pending">Checking calendars…</div>}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Find 45 minutes next week for me, Sarah, and Alex after 2 PM…" aria-label="Scheduling request" maxLength={1000} />
        <button className="btn primary" disabled={busy || input.trim().length < 3}>Find a time</button>
      </form>
    </div>
  );
}

function Summary({ request }: { request: SchedulingRequest }) {
  const p = request.parsed;
  const bits: string[] = [];
  if (p.durationMinutes) bits.push(`${p.durationMinutes} min`);
  if (p.dateRange) bits.push(p.dateRange.start === p.dateRange.end ? p.dateRange.start : `${p.dateRange.start} to ${p.dateRange.end}`);
  if (p.preferredAfter) bits.push(`after ${p.preferredAfter}`);
  if (p.preferredBefore) bits.push(`before ${p.preferredBefore}`);
  if (p.preferredPeriod) bits.push(`prefer ${p.preferredPeriod}`);
  if (p.excludedDays.length) bits.push(`not ${p.excludedDays.map((d) => DAYS[d]).join(', ')}`);
  return (
    <div className="summary">
      <strong>I understood</strong>
      <div className="chips ro">
        {bits.map((b) => <span className="chip" key={b}>{b}</span>)}
        {request.participants.map((x) => <span className="chip person" key={x.email}>{x.name}{!x.required && ' (optional)'}</span>)}
      </div>
    </div>
  );
}

function RequestView({ request, user, busy, onAnswer, onSelect, onRetry }: { request: SchedulingRequest; user: User; busy: boolean; onAnswer: (a: Answers) => void; onSelect: (slotId: string) => void; onRetry: () => void }) {
  return (
    <div className="bot-block">
      <Summary request={request} />
      {request.warnings.map((w) => <p className="notice" key={w}>{w}</p>)}
      {request.status === 'needs_clarification' && <Clarify questions={request.questions} onSubmit={onAnswer} busy={busy} />}
      {request.status === 'no_availability' && request.diagnostics && (
        <div className="card nothing">
          <h3>No time works for everyone</h3>
          <p>{request.diagnostics.message}</p>
          <ul>{request.diagnostics.suggestions.map((s) => <li key={s}>{s}</li>)}</ul>
          <p className="muted">Reply with a change, for example “try the week after” or a shorter meeting.</p>
        </div>
      )}
      {request.status === 'failed' && <button className="btn" onClick={onRetry} disabled={busy}>Try again</button>}
      {(request.status === 'ready' || request.status === 'booked') && request.slots.length > 0 && (
        <>
          <p className="lead">{request.slots.length === 1 ? 'One time works' : `${request.slots.length} times work`}{request.slots[0] ? `, starting with ${fmtDay(request.slots[0].startUtc, user.timezone)}` : ''}. Times shown in {user.timezone}.</p>
          <div className="slots">
            {request.slots.map((s, i) => <SlotCard key={s.id} slot={s} tz={user.timezone} rank={i} onSelect={() => onSelect(s.id)} disabled={busy || request.status === 'booked'} />)}
          </div>
        </>
      )}
    </div>
  );
}
