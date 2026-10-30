/**
 * When a reminder is for, in words: "in 2 h", "tomorrow 9:00", "fri 14:30",
 * "2026-11-03 10:00". Pure, on local time, with `now` passed in.
 *
 * What it reads (case and extra spaces ignored):
 *
 *   in 2 h · in 90 min · in 1h30m · in 2 hours · in 3 days · in 1 week
 *   9:00 · 17:30 · 9am · 5:30pm        today if still ahead, else tomorrow
 *   today 17:30 · tonight             (tonight is 20:00)
 *   tomorrow · tomorrow 9:00 · tomorrow at 9am     (no time: 9:00)
 *   mon … sun, or the full name, with an optional time  (the next one ahead)
 *   2026-11-03 · 2026-11-03 10:00 · 2026-11-03T10:00   (no time: 9:00)
 *
 * Anything else is null: the dialog says it did not understand, rather than
 * guessing a time the person did not mean.
 */

/** The morning a day-only time means. */
export const MORNING_HOUR = 9;
const EVENING_HOUR = 20;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS: ReadonlyArray<[RegExp, number]> = [
  [/^(m|min|mins|minute|minutes)$/, MINUTE],
  [/^(h|hr|hrs|hour|hours)$/, HOUR],
  [/^(d|day|days)$/, DAY],
  [/^(w|wk|wks|week|weeks)$/, 7 * DAY],
];

const WEEKDAYS: Readonly<Record<string, number>> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

function unitMs(unit: string): number | null {
  for (const [re, ms] of UNITS) if (re.test(unit)) return ms;
  return null;
}

/** "in 1h30m", "in 2 hours 15 min": the sum, or null. */
function parseIn(rest: string): number | null {
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let consumed = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const ms = unitMs(m[2] ?? '');
    if (ms === null) return null;
    total += Number(m[1]) * ms;
    consumed += m[0];
  }
  // Every character but spaces and "and" was part of an amount.
  if (consumed.replace(/\s+/g, '') !== rest.replace(/\s+|\band\b/g, '')) return null;
  return total > 0 ? Math.round(total) : null;
}

/** "9", "9:30", "9am", "5:30 pm", "17:30" → [hour, minute], or null. */
export function parseClock(s: string): [number, number] | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(s.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const ampm = m[3];
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'am' && h === 12) h = 0;
    if (ampm === 'pm' && h !== 12) h += 12;
  } else if (h > 23) {
    return null;
  }
  return [h, min];
}

function at(day: Date, [h, min]: [number, number]): number {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, min, 0, 0);
  return d.getTime();
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** The time `input` names, as epoch ms, or null when it is not understood. */
export function parseWhen(input: string, now: Date): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (s === '') return null;

  const inMatch = /^in (.+)$/.exec(s);
  if (inMatch) {
    const ms = parseIn(inMatch[1] ?? '');
    return ms === null ? null : now.getTime() + ms;
  }

  // "tomorrow at 9", "fri at 2pm": "at" is optional everywhere.
  const t = s.replace(/ at /, ' ');

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](.+))?$/.exec(t);
  if (iso) {
    const day = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (day.getMonth() !== Number(iso[2]) - 1) return null; // 2026-02-31
    const clock = iso[4] === undefined ? ([MORNING_HOUR, 0] as [number, number]) : parseClock(iso[4]);
    return clock ? at(day, clock) : null;
  }

  const [head = '', ...tail] = t.split(' ');
  const rest = tail.join(' ');
  const clockOr = (fallback: [number, number]): [number, number] | null => (rest === '' ? fallback : parseClock(rest));

  if (head === 'today') {
    const clock = rest === '' ? null : parseClock(rest);
    return clock ? at(now, clock) : null;
  }
  if (head === 'tonight' && rest === '') return at(now, [EVENING_HOUR, 0]);
  if (head === 'tomorrow') {
    const clock = clockOr([MORNING_HOUR, 0]);
    return clock ? at(addDays(now, 1), clock) : null;
  }
  const wd = Object.prototype.hasOwnProperty.call(WEEKDAYS, head) ? WEEKDAYS[head] : undefined;
  if (wd !== undefined) {
    const clock = clockOr([MORNING_HOUR, 0]);
    if (!clock) return null;
    // The next such day still ahead: today only if its time has not passed.
    for (let n = 0; n <= 7; n++) {
      const day = addDays(now, n);
      if (day.getDay() !== wd) continue;
      const when = at(day, clock);
      if (when > now.getTime()) return when;
    }
    return null;
  }

  // A bare time: today if it is still ahead, else tomorrow.
  const clock = parseClock(t);
  if (clock) {
    const today = at(now, clock);
    return today > now.getTime() ? today : at(addDays(now, 1), clock);
  }
  return null;
}

/** Tomorrow at 9:00: Snooze's "Tomorrow" and the dialog's quick choice. */
export function tomorrowMorning(now: Date): number {
  return at(addDays(now, 1), [MORNING_HOUR, 0]);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

/** "09:05": 24-hour, as the rest of the app's times. */
export function clockText(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Oct 30", with the year only when it is not this one. */
export function dateText(ms: number, now: Date): string {
  const d = new Date(ms);
  const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}`;
}

/** "today 17:30", "tomorrow 09:00", "yesterday 09:00", "Fri Oct 31, 09:00". */
export function whenText(ms: number, now: Date): string {
  const d = new Date(ms);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / DAY);
  const clock = clockText(ms);
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  if (days === -1) return `yesterday ${clock}`;
  return `${DAY_NAMES[d.getDay()]} ${dateText(ms, now)}, ${clock}`;
}

/** `<input type="datetime-local">`'s value for a time: "2026-10-30T09:00". */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
