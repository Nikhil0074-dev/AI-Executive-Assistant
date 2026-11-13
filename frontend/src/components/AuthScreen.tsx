import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { browserTimeZone } from '../lib/time';
import type { User } from '../lib/types';

export default function AuthScreen({ onAuthed }: { onAuthed: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = mode === 'login' ? { email: form.email, password: form.password } : { ...form, timezone: browserTimeZone() };
      const r = await api<{ user: User }>('POST', `/auth/${mode}`, body);
      onAuthed(r.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <section className="auth-pitch">
        <h1>Say when. We find the time.</h1>
        <p>Describe a meeting in plain language. The assistant reads your calendars, finds a time that works for everyone, and drafts the invitation. Nothing is sent until you confirm.</p>
        <div className="demo-line">
          <span>“Find 45 minutes next week for me, Sarah, and Alex after 2 PM. Avoid Friday.”</span>
        </div>
      </section>
      <form className="card auth-card" onSubmit={submit} aria-label={mode === 'login' ? 'Sign in' : 'Create account'}>
        <h2>{mode === 'login' ? 'Sign in' : 'Create your account'}</h2>
        {mode === 'register' && (
          <label>Full name<input required value={form.name} onChange={set('name')} autoComplete="name" /></label>
        )}
        <label>Email<input required type="email" value={form.email} onChange={set('email')} autoComplete="email" /></label>
        <label>Password<input required type="password" minLength={mode === 'register' ? 8 : 1} value={form.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          {mode === 'register' && <small>At least 8 characters.</small>}
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
          {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
        </button>
      </form>
    </main>
  );
}
