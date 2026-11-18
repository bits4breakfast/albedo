/**
 * A standard 5-field cron expression, read for when it next runs (#443).
 *
 * `minute hour day-of-month month day-of-week`, in LOCAL time, as Claude
 * Code's CronCreate takes it. Each field is `*`, a value, a range `a-b`, a
 * step (`*` + `/n`, `a-b/n`, `a/n`), or a comma list of those. Months and
 * weekdays also take their three-letter names; day-of-week takes 0-7, both 0
 * and 7 meaning Sunday. Day-of-month and day-of-week follow the usual cron
 * rule: when both are restricted, a day matching EITHER runs; otherwise
 * both must match. A field restricts when its values are not all of them
 * (31 days, 7 weekdays) -- whatever it is written as, so `1-31` and `*\/1`
 * restrict nothing. That is how Claude Code 2.1.327's scheduler reads it,
 * which is the reader that matters here (vixie cron goes by a leading `*`).
 *
 * Pure, and nothing else: no seconds field, no `@hourly`, no `L`/`W`/`#`.
 * Anything it does not read is `null`, and the caller falls back to what it
 * knew without the expression.
 */

export interface Cron {
  minutes: readonly number[];
  hours: readonly number[];
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** Day-of-month holds all 31 days: it does not restrict the day. */
  anyDay: boolean;
  /** Day-of-week holds all 7 weekdays: it does not restrict the day. */
  anyWeekday: boolean;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const MINUTE = 60_000;
/** How far ahead to look for a run: past every leap-year Feb 29 and every weekday pairing. */
const SEARCH_DAYS = 366 * 8;

function value(raw: string, min: number, max: number, names?: readonly string[]): number | null {
  const named = names?.indexOf(raw.toLowerCase()) ?? -1;
  if (named >= 0) return named + min;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** One field's values, ascending; null when it does not parse. */
function field(raw: string, min: number, max: number, names?: readonly string[]): number[] | null {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const [range, stepRaw, extra] = part.split('/');
    if (range === undefined || extra !== undefined) return null;
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) === 0) return null;
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else {
      const [a, b, more] = range.split('-');
      if (a === undefined || more !== undefined) return null;
      const from = value(a, min, max, names);
      if (from === null) return null;
      lo = from;
      if (b !== undefined) {
        const to = value(b, min, max, names);
        if (to === null || to < from) return null;
        hi = to;
      } else {
        // `a/n` runs from a to the end of the field; a bare `a` is just a.
        hi = stepRaw !== undefined ? max : from;
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size === 0 ? null : [...out].sort((x, y) => x - y);
}

/** The expression read, or null when it is not a 5-field cron this reads. */
export function parseCron(expr: string): Cron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minutes = field(m, 0, 59);
  const hours = field(h, 0, 23);
  const days = field(dom, 1, 31);
  const months = field(mon, 1, 12, MONTH_NAMES);
  const weekdays = field(dow, 0, 7, DAY_NAMES);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  // 7 is Sunday as well as 0.
  const weekdaySet = new Set(weekdays.map((d) => (d === 7 ? 0 : d)));
  return {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: weekdaySet,
    anyDay: days.length === 31,
    anyWeekday: weekdaySet.size === 7,
  };
}

function dayMatches(c: Cron, d: Date): boolean {
  if (!c.months.has(d.getMonth() + 1)) return false;
  const byDay = c.days.has(d.getDate());
  const byWeekday = c.weekdays.has(d.getDay());
  if (!c.anyDay && !c.anyWeekday) return byDay || byWeekday;
  return byDay && byWeekday;
}

/**
 * The first run strictly after `after` (ms), at the start of its minute, in
 * local time; null when the expression does not parse or never runs (Feb 30).
 * A local time that does not exist (a clock going forward) is skipped; one
 * that happens twice (going back) runs at its first.
 */
export function cronNext(expr: string | Cron, after: number): number | null {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  if (c === null || !Number.isFinite(after)) return null;
  const start = new Date(after);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (!dayMatches(c, day)) continue;
    for (const h of c.hours) {
      for (const m of c.minutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        // Not this wall-clock time: the date rolled over it (DST).
        if (at.getHours() !== h || at.getMinutes() !== m) continue;
        if (at.getTime() > after) return at.getTime();
      }
    }
  }
  return null;
}

/**
 * The last run at or before `atOrBefore` (ms), as {@link cronNext} reads
 * runs; null when there is none in the years searched.
 */
export function cronPrev(expr: string | Cron, atOrBefore: number): number | null {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  if (c === null || !Number.isFinite(atOrBefore)) return null;
  const start = new Date(atOrBefore);
  const hours = [...c.hours].reverse();
  const minutes = [...c.minutes].reverse();
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() - i);
    if (!dayMatches(c, day)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        if (at.getHours() !== h || at.getMinutes() !== m) continue;
        if (at.getTime() <= atOrBefore) return at.getTime();
      }
    }
  }
  return null;
}

/**
 * The spacing between runs, in ms, when they are evenly spaced across the
 * whole day, every day, more than once a day: `13,43 * * * *` is 30 minutes,
 * `0 *\/2 * * *` two hours. Null for anything else -- runs on some days only,
 * uneven hours (`0 9,13,17 * * *`), once a day -- where "every" would not be
 * true all the time.
 */
export function cronEvery(expr: string | Cron): number | null {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  if (c === null) return null;
  if (!c.anyDay || !c.anyWeekday || c.months.size !== 12) return null;
  const times = c.hours.flatMap((h) => c.minutes.map((m) => h * 60 + m));
  if (times.length < 2) return null;
  const gap = times[1]! - times[0]!;
  for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! !== gap) return null;
  // Across midnight too: the last run of a day to the first of the next.
  if (times[0]! + 24 * 60 - times[times.length - 1]! !== gap) return null;
  return gap * MINUTE;
}

/** "every 30 min", "every 2 h", "every minute", "every hour". */
export function everyText(ms: number): string {
  const min = Math.round(ms / MINUTE);
  if (min === 1) return 'every minute';
  if (min === 60) return 'every hour';
  if (min % 60 === 0) return `every ${min / 60} h`;
  return `every ${min} min`;
}
