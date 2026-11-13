import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createParser, type RequestParser } from './ai/llmParser';
import { GoogleCalendarProvider } from './calendar/googleProvider';
import { MockCalendarProvider } from './calendar/mockProvider';
import type { CalendarProvider } from './calendar/provider';
import { loadConfig, type Config } from './config';
import { createRouter, errorHandler } from './routes';
import { Store } from './store';

export interface AppOptions {
  config?: Config;
  store?: Store;
  calendar?: CalendarProvider;
  parse?: RequestParser;
  now?: () => number;
  seedDemo?: boolean;
}

export function createApp(opts: AppOptions = {}) {
  const config = opts.config ?? loadConfig();
  const store = opts.store ?? new Store();
  const calendar =
    opts.calendar ??
    (config.calendarMode === 'google'
      ? new GoogleCalendarProvider({ ...config.google, encryptionKey: config.tokenEncryptionKey, stateSecret: config.jwtSecret })
      : new MockCalendarProvider());
  const parse = opts.parse ?? createParser({ apiKey: config.anthropicApiKey, model: config.anthropicModel });
  const now = opts.now ?? Date.now;

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, calendarMode: calendar.mode, parser: config.anthropicApiKey ? 'llm+rules' : 'rules' }));
  app.use('/api', createRouter({ store, calendar, parse, now, config }, { seedDemo: opts.seedDemo ?? false }));
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } }));
  app.use(errorHandler);

  if (config.frontendDist && fs.existsSync(config.frontendDist)) {
    app.use(express.static(config.frontendDist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.resolve(config.frontendDist!, 'index.html')));
  }
  return { app, store, calendar };
}
