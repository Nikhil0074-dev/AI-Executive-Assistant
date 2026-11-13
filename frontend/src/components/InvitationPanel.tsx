import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { fmtFull, fmtRange, minutesBetween } from '../lib/time';
import type { Invitation } from '../lib/types';

interface Props {
  draft: Invitation;
  organizer: string;
  onChange: (d: Invitation) => void;
  onCreated: (d: Invitation) => void;
  onBack: () => void;
  onConflict: (requestId: string, message: string) => void;
}

export default function InvitationPanel({ draft, organizer, onChange, onCreated, onBack, onConflict }: Props) {
  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description);
  const [location, setLocation] = useState(draft.location);
  const [addMeet, setAddMeet] = useState(draft.addMeet);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = draft.status === 'created' || draft.status === 'cancelled';

  async function save(extra: object = {}) {
    const r = await api<{ invitation: Invitation }>('PATCH', `/invitations/${draft.id}`, { title, description, location, addMeet, ...extra });
    onChange(r.invitation);
    return r.invitation;
  }

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      await save();
      const r = await api<{ invitation: Invitation }>('POST', `/invitations/${draft.id}/confirm`, { acknowledgeUnverified: ack });
      onCreated(r.invitation);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SLOT_UNAVAILABLE') onConflict(draft.requestId, e.message);
      else setError(e instanceof ApiError ? e.message : 'Could not send the invitation.');
    } finally {
      setBusy(false);
    }
  }

  async function removeAttendee(email: string) {
    try { await save({ removeAttendees: [email] }); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not update attendees.'); }
  }

  async function cancel() {
    await api('POST', `/invitations/${draft.id}/cancel`).catch(() => {});
    onBack();
  }

  return (
    <section className="card invite" aria-label="Invitation preview">
      <h3>Review the invitation</h3>
      <p className="muted">Nothing has been sent. The event is created in Google Calendar only after you confirm.</p>
      <label>Title<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} disabled={locked} /></label>
      <dl className="facts">
        <dt>When</dt><dd>{fmtFull(draft.startUtc, draft.timezone)} <span className="muted">({fmtRange(draft.startUtc, draft.endUtc, draft.timezone)}, {minutesBetween(draft.startUtc, draft.endUtc)} min, {draft.timezone})</span></dd>
        <dt>Organizer</dt><dd>{organizer}</dd>
        <dt>Attendees</dt>
        <dd>
          <ul className="attendees">
            {draft.attendees.map((a) => (
              <li key={a.email}>
                <span>{a.name}{a.name !== a.email && <small> {a.email}</small>}{!a.required && <em> optional</em>}</span>
                {!locked && <button className="link" onClick={() => removeAttendee(a.email)} aria-label={`Remove ${a.name}`}>Remove</button>}
              </li>
            ))}
            {draft.attendees.length === 0 && <li className="muted">Only you</li>}
          </ul>
        </dd>
      </dl>
      <label>Description<textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} disabled={locked} /></label>
      <label>Location<input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Room, address or video link" disabled={locked} /></label>
      <label className="check"><input type="checkbox" checked={addMeet} onChange={(e) => { setAddMeet(e.target.checked); if (e.target.checked && !location) setLocation('Google Meet'); }} disabled={locked} />Add a Google Meet link</label>
      {draft.unverified.length > 0 && (
        <label className="check warnbox">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>Availability for {draft.unverified.join(', ')} could not be checked. Send anyway.</span>
        </label>
      )}
      {draft.status === 'failed' && <p className="error" role="alert">The last attempt failed. Your draft is saved, so you can try again.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn primary" onClick={confirm} disabled={busy || locked || (draft.unverified.length > 0 && !ack)}>{busy ? 'Sending…' : 'Confirm and send invitation'}</button>
        <button className="btn" onClick={onBack} disabled={busy}>Choose another time</button>
        <button className="link" onClick={cancel} disabled={busy}>Discard draft</button>
      </div>
    </section>
  );
}
