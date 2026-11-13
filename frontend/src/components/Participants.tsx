import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import type { Participant } from '../lib/types';

export default function Participants() {
  const [list, setList] = useState<Participant[]>([]);
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ name: '', email: '', timezone: '', required: true });
  const [error, setError] = useState('');

  const load = useCallback(async () => setList((await api('GET', `/participants?q=${encodeURIComponent(q)}`)).participants), [q]);
  useEffect(() => { void load(); }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('POST', '/participants', { name: form.name, email: form.email, required: form.required, ...(form.timezone ? { timezone: form.timezone } : {}) });
      setForm({ name: '', email: '', timezone: '', required: true });
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the participant.');
    }
  }
  async function toggle(p: Participant) { await api('PATCH', `/participants/${p.id}`, { required: !p.required }); void load(); }
  async function remove(p: Participant) { await api('DELETE', `/participants/${p.id}`); void load(); }

  return (
    <div className="people">
      <form className="card" onSubmit={add}>
        <h2>Add a participant</h2>
        <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>Time zone <small>optional, e.g. Europe/London</small><input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} />Required by default</label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary">Save participant</button>
      </form>
      <section className="card">
        <h2>Saved participants</h2>
        <input type="search" placeholder="Search by name or email" aria-label="Search participants" value={q} onChange={(e) => setQ(e.target.value)} />
        {list.length === 0 ? <p className="muted">No participants match.</p> : (
          <ul className="plist">
            {list.map((p) => (
              <li key={p.id}>
                <div><strong>{p.name}</strong><small>{p.email}{p.timezone ? ` · ${p.timezone}` : ''}</small></div>
                <button className="chip" onClick={() => toggle(p)} aria-label={`Toggle required for ${p.name}`}>{p.required ? 'Required' : 'Optional'}</button>
                <button className="link" onClick={() => remove(p)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
