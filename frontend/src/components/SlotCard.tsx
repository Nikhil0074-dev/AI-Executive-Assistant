import { fmtDay, fmtRange, minutesBetween } from '../lib/time';
import type { Slot } from '../lib/types';
import Timeline from './Timeline';

export default function SlotCard({ slot, tz, rank, onSelect, disabled }: { slot: Slot; tz: string; rank: number; onSelect: () => void; disabled?: boolean }) {
  const others = slot.localTimes.filter((l) => l.timezone !== tz);
  return (
    <article className={`card slot ${rank === 0 ? 'best' : ''}`}>
      <header>
        <div>
          <h3>{fmtDay(slot.startUtc, tz)}</h3>
          <p className="time">{fmtRange(slot.startUtc, slot.endUtc, tz)}</p>
        </div>
        <div className="slot-meta">
          <span className="pill">{minutesBetween(slot.startUtc, slot.endUtc)} min</span>
          {rank === 0 && <span className="pill accent">Best match</span>}
          {slot.unverified.length > 0 && <span className="pill warn">Not fully verified</span>}
        </div>
      </header>
      <Timeline slot={slot} tz={tz} />
      <ul className="avail">
        {slot.timeline.rows.map((r) => (
          <li key={r.email} className={r.status}><span className="dot" />{r.label}: {r.status === 'free' ? 'free' : r.status === 'busy' ? 'busy' : 'unknown'}</li>
        ))}
      </ul>
      {others.length > 0 && (
        <ul className="locals">
          {others.map((l) => <li key={l.timezone}><strong>{l.label}</strong> <span>{l.text}</span> <small>{l.timezone.replace('_', ' ')}</small></li>)}
        </ul>
      )}
      <p className="why">{slot.explanation}</p>
      <button className="btn primary" onClick={onSelect} disabled={disabled}>Choose this time</button>
    </article>
  );
}
