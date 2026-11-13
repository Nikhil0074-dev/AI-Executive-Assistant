import type { CalendarProvider } from '../calendar/provider';
import type { RequestParser } from '../ai/llmParser';
import type { Config } from '../config';
import type { Store } from '../store';

export interface Deps {
  store: Store;
  calendar: CalendarProvider;
  parse: RequestParser;
  now: () => number;
  config: Config;
}
