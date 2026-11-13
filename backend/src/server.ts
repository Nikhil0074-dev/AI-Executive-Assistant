import path from 'node:path';
import fs from 'node:fs';
import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const dist = config.frontendDist ?? path.resolve(process.cwd(), '../frontend/dist');
const { app, calendar } = createApp({ config: { ...config, frontendDist: fs.existsSync(dist) ? dist : undefined }, seedDemo: config.calendarMode === 'mock' });

// Express error handler must stay last; createApp registers it before static files, so API errors are JSON.
app.listen(config.port, () => {
  console.log(`AI Executive Assistant running on http://localhost:${config.port}`);
  console.log(`Calendar: ${calendar.mode}${calendar.mode === 'mock' ? ' (demo data; set GOOGLE_CLIENT_ID/SECRET for real Google Calendar)' : ''}`);
  console.log(`Parser: ${config.anthropicApiKey ? 'LLM with rule-based fallback' : 'rule-based (set ANTHROPIC_API_KEY for LLM parsing)'}`);
});
