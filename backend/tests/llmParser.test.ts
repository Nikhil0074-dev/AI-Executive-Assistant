import { describe, it, expect, vi } from 'vitest';
import { createParser } from '../src/ai/llmParser';

const ctx = { nowMs: Date.parse('2026-11-07T09:00:00Z'), tz: 'UTC' };
const reply = (text: string, ok = true) =>
  vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ content: [{ type: 'text', text }] }) }) as unknown as Response);

const good = JSON.stringify({
  durationMinutes: 45,
  participants: [{ name: 'Sarah' }],
  dateRange: { start: '2026-11-09', end: '2026-11-15' },
  excludedDays: [5],
  wantsMeet: false,
});

describe('LLM parser', () => {
  it('uses deterministic rules when no API key is configured', async () => {
    const f = vi.fn();
    const r = await createParser({ model: 'm', fetchImpl: f as never })('30 minutes tomorrow with Bo', ctx);
    expect(r.source).toBe('rules');
    expect(f).not.toHaveBeenCalled();
  });
  it('validates and returns structured LLM output', async () => {
    const f = reply(good);
    const r = await createParser({ apiKey: 'k', model: 'claude-test', fetchImpl: f as never })('anything', ctx);
    expect(r.source).toBe('llm');
    expect(r.parsed.durationMinutes).toBe(45);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-test');
    expect(body.system).toContain('2026-11-07');
    expect(body.system).toContain('untrusted');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
  });
  it('strips markdown fences around JSON', async () => {
    const r = await createParser({ apiKey: 'k', model: 'm', fetchImpl: reply('```json\n' + good + '\n```') as never })('x', ctx);
    expect(r.source).toBe('llm');
  });
  it('falls back to rules when the model returns invalid JSON', async () => {
    const r = await createParser({ apiKey: 'k', model: 'm', fetchImpl: reply('Sure! Here you go') as never })('30 minutes tomorrow with Bo', ctx);
    expect(r.source).toBe('rules');
    expect(r.parsed.durationMinutes).toBe(30);
  });
  it('falls back when output violates the schema (e.g. injected fields / bad values)', async () => {
    const bad = JSON.stringify({ participants: [{ email: 'nope' }], durationMinutes: 99999 });
    const r = await createParser({ apiKey: 'k', model: 'm', fetchImpl: reply(bad) as never })('30 minutes tomorrow with Bo', ctx);
    expect(r.source).toBe('rules');
  });
  it('falls back on HTTP errors and network failures', async () => {
    const a = await createParser({ apiKey: 'k', model: 'm', fetchImpl: reply('', false) as never })('30 minutes tomorrow with Bo', ctx);
    expect(a.source).toBe('rules');
    const boom = vi.fn(async () => { throw new Error('network'); });
    const b = await createParser({ apiKey: 'k', model: 'm', fetchImpl: boom as never })('30 minutes tomorrow with Bo', ctx);
    expect(b.source).toBe('rules');
  });
});
