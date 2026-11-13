import { useState } from 'react';
import type { Answers, Question } from '../lib/types';

export default function Clarify({ questions, onSubmit, busy }: { questions: Question[]; onSubmit: (a: Answers) => void; busy: boolean }) {
  const [duration, setDuration] = useState<number>();
  const [range, setRange] = useState<string>();
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState('');

  const ready = questions.every((q) => {
    if (q.field === 'duration') return !!duration;
    if (q.field === 'dateRange') return !!range;
    if (q.field === 'participants') return extra.trim().length > 0;
    return !!emails[q.name!];
  });

  function submit() {
    const a: Answers = {};
    if (duration) a.durationMinutes = duration;
    if (range) a.dateRangeKeyword = range;
    if (Object.keys(emails).length) a.participantEmails = emails;
    if (extra.trim()) a.extraParticipants = extra.split(/[,\s;]+/).filter(Boolean);
    onSubmit(a);
  }

  return (
    <div className="clarify">
      {questions.map((q) => (
        <fieldset key={q.id}>
          <legend>{q.prompt}</legend>
          {q.error && <p className="error" role="alert">{q.error}</p>}
          {q.field === 'duration' && (
            <div className="chips">
              {q.options!.map((o) => (
                <button key={o.value} type="button" className={`chip ${duration === Number(o.value) ? 'on' : ''}`} onClick={() => setDuration(Number(o.value))}>{o.label}</button>
              ))}
            </div>
          )}
          {q.field === 'dateRange' && (
            <div className="chips">
              {q.options!.map((o) => (
                <button key={o.value} type="button" className={`chip ${range === o.value ? 'on' : ''}`} onClick={() => setRange(o.value)}>{o.label}</button>
              ))}
            </div>
          )}
          {q.field === 'participantEmail' && (
            <input type="email" placeholder="name@company.com" aria-label={`Email for ${q.name}`} value={emails[q.name!] ?? ''} onChange={(e) => setEmails({ ...emails, [q.name!]: e.target.value })} />
          )}
          {q.field === 'participantChoice' && (
            <div className="chips">
              {q.options!.map((o) => (
                <button key={o.value} type="button" className={`chip ${emails[q.name!] === o.value ? 'on' : ''}`} onClick={() => setEmails({ ...emails, [q.name!]: o.value })}>{o.label}</button>
              ))}
            </div>
          )}
          {q.field === 'participants' && (
            <input type="text" placeholder="sarah@company.com, alex@company.com" aria-label="Attendee emails" value={extra} onChange={(e) => setExtra(e.target.value)} />
          )}
        </fieldset>
      ))}
      <button className="btn primary" disabled={!ready || busy} onClick={submit}>{busy ? 'Checking calendars…' : 'Continue'}</button>
    </div>
  );
}
