/**
 * The 5-field cron reader (#443). Every time is built in local time, as the
 * cron is read, so the suite holds in any time zone.
 */
import { describe, expect, it } from 'vitest';

import { cronEvery, cronNext, cronPrev, everyText, parseCron } from './cron';

/** Local time; month 1-12. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const MIN = 60_000;

describe('parseCron', () => {
  it('reads values, ranges, steps, lists and *', () => {
    const c = parseCron('13,43 */6 1-3 1/5 1-5/2')!;
    expect(c.minutes).toEqual([13, 43]);
    expect(c.hours).toEqual([0, 6, 12, 18]);
    expect([...c.days]).toEqual([1, 2, 3]);
    expect([...c.months]).toEqual([1, 6, 11]);
    expect([...c.weekdays]).toEqual([1, 3, 5]);
    expect(parseCron('3-59/10 * * * *')!.minutes).toEqual([3, 13, 23, 33, 43, 53]);
  });

  it('takes names, and 7 as Sunday', () => {
    const c = parseCron('0 9 * jan,Mar MON-fri')!;
    expect([...c.months]).toEqual([1, 3]);
    expect([...c.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 9 * * 7')!.weekdays]).toEqual([0]);
    expect([...parseCron('0 9 * * 5-7')!.weekdays].sort()).toEqual([0, 5, 6]);
  });

  it('refuses what it does not read', () => {
    for (const bad of [
      '',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      '*/0 * * * *',
      '5-1 * * * *',
      '@hourly',
      '0 9 L * *',
      'a b c d e',
      '1-2-3 * * * *',
      '1/2/3 * * * *',
    ]) {
      expect(parseCron(bad), bad).toBeNull();
    }
  });
});

describe('cronNext', () => {
  it('finds the next slot strictly after the time, on the minute', () => {
    expect(cronNext('13,43 * * * *', at(2026, 11, 18, 13, 52, 10))).toBe(at(2026, 11, 18, 14, 13));
    expect(cronNext('13,43 * * * *', at(2026, 11, 18, 14, 13))).toBe(at(2026, 11, 18, 14, 43));
    expect(cronNext('13,43 * * * *', at(2026, 11, 18, 14, 12, 59))).toBe(at(2026, 11, 18, 14, 13));
    expect(cronNext('*/15 * * * *', at(2026, 11, 18, 23, 50))).toBe(at(2026, 11, 19, 0, 0));
  });

  it('crosses days, months and years', () => {
    // Wed 18 Nov 2026, after 17:00: weekdays 9, 13, 17 -> Thu 09:00.
    expect(cronNext('0 9,13,17 * * 1-5', at(2026, 11, 18, 17, 30))).toBe(at(2026, 11, 19, 9, 0));
    // Fri evening -> Mon morning.
    expect(cronNext('0 9 * * 1-5', at(2026, 11, 20, 18, 0))).toBe(at(2026, 11, 23, 9, 0));
    expect(cronNext('30 14 28 10 *', at(2026, 11, 18))).toBe(at(2027, 10, 28, 14, 30));
    expect(cronNext('0 0 29 2 *', at(2026, 3, 1))).toBe(at(2028, 2, 29, 0, 0));
  });

  it('runs on either day when both day fields are restricted, on both otherwise', () => {
    // The 1st, or any Monday: from Wed 18 Nov 2026, Mon 23 Nov comes first.
    expect(cronNext('0 9 1 * 1', at(2026, 11, 18))).toBe(at(2026, 11, 23, 9, 0));
    // A day field starting with * does not restrict: Mondays only.
    expect(cronNext('0 9 * * 1', at(2026, 11, 18))).toBe(at(2026, 11, 23, 9, 0));
    expect(cronNext('0 9 */1 * 1', at(2026, 11, 18))).toBe(at(2026, 11, 23, 9, 0));
    // The 1st only.
    expect(cronNext('0 9 1 * *', at(2026, 11, 18))).toBe(at(2026, 12, 1, 9, 0));
  });

  it('is null for a date that never comes, and for an unreadable expression', () => {
    expect(cronNext('0 0 30 2 *', at(2026, 1, 1))).toBeNull();
    expect(cronNext('not a cron', at(2026, 1, 1))).toBeNull();
    expect(cronNext('* * * * *', Number.NaN)).toBeNull();
  });

  it('takes a parsed expression as well', () => {
    expect(cronNext(parseCron('0 * * * *')!, at(2026, 11, 18, 13, 1))).toBe(at(2026, 11, 18, 14, 0));
  });

  it('skips a day whose 02:30 does not exist, rather than running at 03:30', () => {
    // Across a year in the suite's time zone: where the clock jumps over
    // 02:30 (TZ=America/New_York, Mar 8 2026) that day has no run.
    let t = at(2026, 1, 1);
    for (let i = 0; i < 365; i++) {
      const next = cronNext('30 2 * * *', t)!;
      const d = new Date(next);
      expect([d.getHours(), d.getMinutes()]).toEqual([2, 30]);
      t = next;
    }
  });

  it('never returns a local time that does not exist', () => {
    // Every minute for two days from each month start: each run is on its
    // minute and one minute after the last, except across a clock change.
    for (let mo = 1; mo <= 12; mo++) {
      let t = at(2026, mo, 1) - 1;
      for (let i = 0; i < 60; i++) {
        const next = cronNext('30 * * * *', t)!;
        expect(new Date(next).getMinutes()).toBe(30);
        expect(next).toBeGreaterThan(t);
        t = next;
      }
    }
  });
});

describe('cronPrev', () => {
  it('finds the last slot at or before the time', () => {
    expect(cronPrev('13,43 * * * *', at(2026, 11, 18, 11, 17, 35))).toBe(at(2026, 11, 18, 11, 13));
    expect(cronPrev('13,43 * * * *', at(2026, 11, 18, 11, 13))).toBe(at(2026, 11, 18, 11, 13));
    expect(cronPrev('0 9 * * 1-5', at(2026, 11, 23, 8, 0))).toBe(at(2026, 11, 20, 9, 0));
    expect(cronPrev('0 0 30 2 *', at(2026, 1, 1))).toBeNull();
    expect(cronPrev('nope', at(2026, 1, 1))).toBeNull();
  });
});

describe('cronEvery', () => {
  it('is the spacing when runs are even across the whole day', () => {
    expect(cronEvery('13,43 * * * *')).toBe(30 * MIN);
    expect(cronEvery('*/15 * * * *')).toBe(15 * MIN);
    expect(cronEvery('3-59/10 * * * *')).toBe(10 * MIN);
    expect(cronEvery('0 */2 * * *')).toBe(120 * MIN);
    expect(cronEvery('* * * * *')).toBe(MIN);
    expect(cronEvery('5 * * * *')).toBe(60 * MIN);
    expect(cronEvery('0 0,12 * * *')).toBe(12 * 60 * MIN);
  });

  it('is null when "every" would not always be true', () => {
    // Uneven within the hour, or across it.
    expect(cronEvery('0,10 * * * *')).toBeNull();
    expect(cronEvery('*/7 * * * *')).toBeNull();
    // Uneven hours, or not every hour.
    expect(cronEvery('0 9,13,17 * * *')).toBeNull();
    expect(cronEvery('*/15 9-17 * * *')).toBeNull();
    expect(cronEvery('0 */5 * * *')).toBeNull();
    // Some days only.
    expect(cronEvery('13,43 * * * 1-5')).toBeNull();
    expect(cronEvery('13,43 * 1 * *')).toBeNull();
    expect(cronEvery('13,43 * * 1 *')).toBeNull();
    // Once a day.
    expect(cronEvery('0 9 * * *')).toBeNull();
    expect(cronEvery('bad')).toBeNull();
  });
});

describe('everyText', () => {
  it('says the spacing in minutes or hours', () => {
    expect(everyText(30 * MIN)).toBe('every 30 min');
    expect(everyText(15 * MIN)).toBe('every 15 min');
    expect(everyText(120 * MIN)).toBe('every 2 h');
    expect(everyText(60 * MIN)).toBe('every hour');
    expect(everyText(MIN)).toBe('every minute');
  });
});
