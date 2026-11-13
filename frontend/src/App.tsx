import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './lib/api';
import type { User } from './lib/types';
import Assistant from './components/Assistant';
import AuthScreen from './components/AuthScreen';
import Dashboard from './components/Dashboard';
import Participants from './components/Participants';

type Tab = 'assistant' | 'dashboard' | 'participants';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>('assistant');
  const [resume, setResume] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api<{ user: User }>('GET', '/auth/me').then((r) => setUser(r.user)).catch(() => setUser(null)).finally(() => setChecking(false));
  }, []);
  const refresh = useCallback(async () => { try { setUser((await api<{ user: User }>('GET', '/auth/me')).user); } catch { setUser(null); } }, []);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  async function connect() {
    try {
      const r = await api<{ redirectUrl?: string }>('POST', '/calendar/connect');
      if (r.redirectUrl) { window.location.href = r.redirectUrl; return; }
      await refresh();
    } catch (e) { setNotice(e instanceof ApiError ? e.message : 'Could not connect.'); }
  }
  async function disconnect() { await api('DELETE', '/calendar/connection'); await refresh(); }
  async function logout() { await api('POST', '/auth/logout'); setUser(null); }

  if (checking) return <div className="boot">Loading…</div>;
  if (!user) return <AuthScreen onAuthed={setUser} />;

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">Executive Assistant</div>
        <nav aria-label="Main">
          {(['assistant', 'dashboard', 'participants'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)} aria-current={tab === t ? 'page' : undefined}>
              {t === 'assistant' ? 'Assistant' : t === 'dashboard' ? 'Dashboard' : 'Participants'}
            </button>
          ))}
        </nav>
        <div className="who">
          {user.calendar.connected
            ? <span className="status-pill ok"><span className="dot ok" />Calendar connected</span>
            : <button className="status-pill off" onClick={connect}><span className="dot off" />Connect Google Calendar</button>}
          <button className="link" onClick={logout}>Sign out</button>
        </div>
      </header>
      {notice && <p className="notice banner" role="alert">{notice} <button className="link" onClick={() => setNotice('')}>Dismiss</button></p>}
      {!user.calendar.connected && tab === 'assistant' && (
        <p className="notice banner">Connect Google Calendar so the assistant can check availability. <button className="link" onClick={connect}>Connect now</button></p>
      )}
      <main className="page">
        <div hidden={tab !== 'assistant'}><Assistant user={user} resumeDraft={resume} onResumed={() => setResume(null)} onChanged={bump} /></div>
        {tab === 'dashboard' && <Dashboard user={user} version={version} onResume={(id) => { setResume(id); setTab('assistant'); }} onConnect={connect} onDisconnect={disconnect} />}
        {tab === 'participants' && <Participants />}
      </main>
    </div>
  );
}
