import type { ParsedRequest, Period } from '../types';
import { addDays, hhmmOf, localDateOf } from '../utils/timezone';
import { WEEKDAYS, firstDayOfNextMonth, lastDayOfMonth, nextOccurrence, rangeForKeyword } from './dates';

const DAY = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?!\d|\s*(?:min|hour|hr|h\b|-))`;
const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, 'forty five': 45, sixty: 60, ninety: 90,
};
const NOT_PEOPLE = new Set(['me', 'myself', 'i', 'us', 'we', 'you', 'everyone', 'anyone', 'all', 'them', 'everybody', 'it', 'a', 'an', 'the']);

function toMinutes(h: string, m: string | undefined, mer: string | undefined): number | undefined {
  let hour = Number(h);
  const min = m ? Number(m) : 0;
  if (hour > 23 || min > 59) return undefined;
  const meridiem = mer?.toLowerCase().replace(/\./g, '');
  if (meridiem === 'pm' && hour < 12) hour += 12;
  else if (meridiem === 'am' && hour === 12) hour = 0;
  else if (!meridiem && !m && hour >= 1 && hour <= 7) hour += 12;
  else if (!meridiem && !m && hour === 12) hour = 12;
  return hour * 60 + min;
}

function dayIndex(name: string): number {
  return WEEKDAYS.indexOf(name.toLowerCase().replace(/s$/, ''));
}

export function parseWithRules(prompt: string, ctx: { nowMs: number; tz: string }): ParsedRequest {
  let text = ` ${prompt.replace(/\s+/g, ' ').trim()} `;
  const today = localDateOf(ctx.nowMs, ctx.tz);
  const out: ParsedRequest = { participants: [], excludedDays: [], wantsMeet: false };

  // --- emails ---------------------------------------------------------
  const emails = [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
  text = text.replace(EMAIL_RE, ' ');

  // --- participants (names) ----------------------------------------------
  const names: { name: string; required: boolean }[] = [];
  const cut = /\b(?:next|this|tomorrow|today|tonight|on|after|before|avoid|except|excluding|between|at|for|in|to|when|using|via|during|by|from|but|so|that|preferably|with)\b|\d|[.;!?]/i;
  for (const m of text.matchAll(/\b(?:with|for|including)\s+/gi)) {
    const tail = text.slice(m.index! + m[0].length);
    const end = tail.search(cut);
    const chunk = end === -1 ? tail : tail.slice(0, end);
    const found: { name: string; required: boolean }[] = [];
    for (const raw of chunk.split(/,|\band\b|&/i)) {
      const optional = /\(\s*optional\s*\)/i.test(raw);
      const name = raw.replace(/\(\s*optional\s*\)/gi, '').replace(/^\s*(?:the|my)\s+/i, '').trim();
      if (!name || NOT_PEOPLE.has(name.toLowerCase()) || !/^[A-Za-z][A-Za-z'.-]*(?: [A-Za-z][A-Za-z'.-]*){0,2}$/.test(name)) continue;
      found.push({ name: name.charAt(0).toUpperCase() + name.slice(1), required: !optional });
    }
    if (found.length) {
      names.push(...found);
      break;
    }
  }
  const seen = new Set<string>();
  for (const e of emails) out.participants.push({ email: e });
  for (const n of names) {
    if (seen.has(n.name.toLowerCase())) continue;
    seen.add(n.name.toLowerCase());
    out.participants.push({ name: n.name, ...(n.required ? {} : { required: false }) });
  }

  // --- meet link ------------------------------------------------------------
  if (/\b(google\s+meet|meet\s+link|video\s*(?:call|conference)|zoom)\b/i.test(text)) out.wantsMeet = true;

  // --- excluded days -------------------------------------------------------
  const excl = new RegExp(String.raw`\b(?:avoid|except|excluding|exclude|not\s+on|other\s+than|skip|without|no)\s+(?:on\s+)?${DAY}(?:\s*(?:,|and|or)\s*${DAY})*`, 'gi');
  for (const m of text.matchAll(excl)) {
    for (const d of m[0].matchAll(new RegExp(DAY, 'gi'))) {
      const i = dayIndex(d[1]);
      if (!out.excludedDays.includes(i)) out.excludedDays.push(i);
    }
  }
  text = text.replace(excl, ' ');

  // --- "before <weekday>" upper bound ---------------------------------------
  let upper: string | undefined;
  const beforeDay = new RegExp(String.raw`\b(?:before|until|by)\s+${DAY}`, 'i').exec(text);
  if (beforeDay) {
    upper = addDays(nextOccurrence(today, dayIndex(beforeDay[1]), false), -1);
    text = text.replace(beforeDay[0], ' ');
  }

  // --- explicit dates -------------------------------------------------------
  let range: { start: string; end: string } | undefined;
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  const md = new RegExp(String.raw`\b(?:${MONTH_RE}\.?\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_RE})\b`, 'i').exec(text);
  if (iso) {
    range = { start: iso[1], end: iso[1] };
    text = text.replace(iso[0], ' ');
  } else if (md) {
    const month = MONTHS.indexOf((md[1] ?? md[4]).slice(0, 3).toLowerCase()) + 1;
    const day = Number(md[2] ?? md[3]);
    const year = Number(today.slice(0, 4));
    let date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (date < today) date = `${year + 1}${date.slice(4)}`;
    if (!Number.isNaN(new Date(`${date}T00:00:00Z`).getTime()) && Number(date.slice(8)) === day) {
      range = { start: date, end: date };
      text = text.replace(md[0], ' ');
    }
  }

  // --- time constraints -----------------------------------------------------
  const between = new RegExp(String.raw`\bbetween\s+${TIME}\s+(?:and|to|-)\s+${TIME}`, 'i').exec(text);
  if (between) {
    const [, h1, m1, mer1, h2, m2, mer2] = between;
    const a = toMinutes(h1, m1, mer1 ?? mer2);
    const b = toMinutes(h2, m2, mer2);
    if (a !== undefined && b !== undefined && a < b) {
      out.preferredAfter = hhmmOf(a);
      out.preferredBefore = hhmmOf(b);
    }
    text = text.replace(between[0], ' ');
  }
  const word = (re: RegExp, set: (min: number) => void) => {
    const m = re.exec(text);
    if (m) {
      set(m[0].toLowerCase().includes('lunch') && /after/i.test(m[0]) ? 13 * 60 : 12 * 60);
      text = text.replace(m[0], ' ');
    }
  };
  word(/\bafter\s+(?:noon|lunch)\b/i, (m) => (out.preferredAfter = hhmmOf(m)));
  word(/\bbefore\s+(?:noon|lunch)\b/i, (m) => (out.preferredBefore = hhmmOf(m)));
  const after = new RegExp(String.raw`\b(?:after|from|starting(?:\s+at)?|no\s+earlier\s+than|not\s+before)\s+${TIME}`, 'i').exec(text);
  if (after && !out.preferredAfter) {
    const v = toMinutes(after[1], after[2], after[3]);
    if (v !== undefined) out.preferredAfter = hhmmOf(v);
    text = text.replace(after[0], ' ');
  }
  const before = new RegExp(String.raw`\b(?:before|until|by|ending(?:\s+at)?|no\s+later\s+than|not\s+after)\s+${TIME}`, 'i').exec(text);
  if (before && !out.preferredBefore) {
    const v = toMinutes(before[1], before[2], before[3]);
    if (v !== undefined) out.preferredBefore = hhmmOf(v);
    text = text.replace(before[0], ' ');
  }
  const period = /\b(morning|afternoon|evening)\b/i.exec(text);
  if (period) out.preferredPeriod = period[1].toLowerCase() as Period;

  // --- duration ---------------------------------------------------------------
  let dur: number | undefined;
  const numeric = /(\d+(?:\.\d+)?)\s*-?\s*(minutes?|mins?|hours?|hrs?|h)\b/i.exec(text);
  const words = /\b(half\s+an?\s+hour|half[- ]hour|(?:an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty[- ]five|forty|sixty|ninety)[ -](?:hours?|minutes?|mins?))\b/i.exec(text);
  if (numeric) {
    const n = Number(numeric[1]);
    dur = Math.round(/^h/i.test(numeric[2]) ? n * 60 : n);
  } else if (words) {
    const w = words[1].toLowerCase();
    if (w.startsWith('half')) dur = 30;
    else {
      const [num, unit] = w.split(/[ -](?=hours?|minutes?|mins?$)/);
      const n = NUM_WORDS[num.replace(/\s+/g, ' ')];
      if (n) dur = unit.startsWith('h') ? n * 60 : n;
    }
  }
  if (dur && dur >= 5 && dur <= 480) out.durationMinutes = dur;

  // --- relative dates -----------------------------------------------------------
  const weekdayNames: { day: number; exclusive: boolean }[] = [];
  for (const m of text.matchAll(new RegExp(String.raw`\b(next\s+|on\s+|this\s+)?${DAY}`, 'gi'))) {
    weekdayNames.push({ day: dayIndex(m[2]), exclusive: /^next/i.test(m[1] ?? '') });
  }
  if (!range) {
    if (/\bday after tomorrow\b/i.test(text)) range = { start: addDays(today, 2), end: addDays(today, 2) };
    else if (/\btomorrow\b/i.test(text)) range = rangeForKeyword('tomorrow', ctx.nowMs, ctx.tz);
    else if (/\b(today|tonight)\b/i.test(text)) range = rangeForKeyword('today', ctx.nowMs, ctx.tz);
    else if (/\bnext\s+week\b/i.test(text)) range = rangeForKeyword('next_week', ctx.nowMs, ctx.tz);
    else if (/\bthis\s+week\b/i.test(text)) range = rangeForKeyword('this_week', ctx.nowMs, ctx.tz);
    else if (/\bnext\s+month\b/i.test(text)) {
      const start = firstDayOfNextMonth(today);
      range = { start, end: lastDayOfMonth(start) };
    } else if (/\b(this\s+month|end\s+of\s+(?:the\s+)?month)\b/i.test(text)) range = { start: today, end: lastDayOfMonth(today) };
  }
  if (weekdayNames.length) {
    const days = [...new Set(weekdayNames.map((w) => w.day))];
    if (range && range.start !== range.end) {
      out.allowedDays = days;
    } else if (!range) {
      const dates = weekdayNames.map((w) => nextOccurrence(today, w.day, !w.exclusive)).sort();
      range = { start: dates[0], end: dates[dates.length - 1] };
      if (days.length > 1) out.allowedDays = days;
    }
  }
  if (upper) {
    if (!range) range = upper >= today ? { start: today, end: upper } : undefined;
    else if (upper >= range.start) range = { start: range.start, end: upper < range.end ? upper : range.end };
  }
  if (range) out.dateRange = range;

  // --- title -----------------------------------------------------------------------
  const title = /\b([a-z]+(?:[ -][a-z]+)? (?:review|sync|call|discussion|stand-?up|planning|retrospective|interview|workshop|catch-?up|demo|kickoff|1:1))\b/i.exec(prompt);
  if (title) {
    const t = title[1].replace(/^(?:a|an|the|schedule|book|arrange|set up)\s+/i, '').trim();
    if (t.length > 3) out.title = t.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return out;
}
