import { describe, expect, it } from 'vitest';
import { clockText, parseClock, parseWhen, toLocalInput, tomorrowMorning, whenText } from './when';

// Fri Oct 30 2026, 14:20 local.
const NOW = new Date(2026, 9, 30, 14, 20, 0, 0);
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('parseWhen', () => {
  it('reads "in …" amounts, alone and combined', () => {
    const t = NOW.getTime();
    expect(parseWhen('in 2 h', NOW)).toBe(t + 2 * 3_600_000);
    expect(parseWhen('in 2h', NOW)).toBe(t + 2 * 3_600_000);
    expect(parseWhen('In 90 min', NOW)).toBe(t + 90 * 60_000);
    expect(parseWhen('in 1h30m', NOW)).toBe(t + 90 * 60_000);
    expect(parseWhen('in 2 hours and 15 minutes', NOW)).toBe(t + 135 * 60_000);
    expect(parseWhen('in 3 days', NOW)).toBe(t + 3 * 86_400_000);
    expect(parseWhen('in 1 week', NOW)).toBe(t + 7 * 86_400_000);
  });

  it('refuses amounts it cannot read rather than guessing', () => {
    expect(parseWhen('in 2 parsecs', NOW)).toBeNull();
    expect(parseWhen('in a while', NOW)).toBeNull();
    expect(parseWhen('in 0 h', NOW)).toBeNull();
    expect(parseWhen('', NOW)).toBeNull();
    expect(parseWhen('soonish', NOW)).toBeNull();
  });

  it('reads tomorrow, with and without a time ("at" optional)', () => {
    expect(parseWhen('tomorrow 9:00', NOW)).toBe(local(2026, 10, 31, 9));
    expect(parseWhen('tomorrow at 9am', NOW)).toBe(local(2026, 10, 31, 9));
    expect(parseWhen('tomorrow 5:30pm', NOW)).toBe(local(2026, 10, 31, 17, 30));
    expect(parseWhen('tomorrow', NOW)).toBe(local(2026, 10, 31, 9));
    expect(parseWhen('tomorrow 25:00', NOW)).toBeNull();
  });

  it('a bare time is today when still ahead, else tomorrow', () => {
    expect(parseWhen('17:30', NOW)).toBe(local(2026, 10, 30, 17, 30));
    expect(parseWhen('9:00', NOW)).toBe(local(2026, 10, 31, 9));
    expect(parseWhen('today 17:30', NOW)).toBe(local(2026, 10, 30, 17, 30));
    expect(parseWhen('tonight', NOW)).toBe(local(2026, 10, 30, 20));
  });

  it('a weekday is the next one ahead, today only if its time has not passed', () => {
    expect(parseWhen('mon', NOW)).toBe(local(2026, 11, 2, 9));
    expect(parseWhen('monday 14:00', NOW)).toBe(local(2026, 11, 2, 14));
    // Today is Friday: 14:00 has passed, 15:00 has not.
    expect(parseWhen('fri at 2pm', NOW)).toBe(local(2026, 11, 6, 14));
    expect(parseWhen('fri 15:00', NOW)).toBe(local(2026, 10, 30, 15));
    expect(parseWhen('thursday 9:00', NOW)).toBe(local(2026, 11, 5, 9));
  });

  it('reads ISO dates, with 09:00 for a date alone, and refuses impossible ones', () => {
    expect(parseWhen('2026-11-03 10:00', NOW)).toBe(local(2026, 11, 3, 10));
    expect(parseWhen('2026-11-03T10:00', NOW)).toBe(local(2026, 11, 3, 10));
    expect(parseWhen('2026-11-03', NOW)).toBe(local(2026, 11, 3, 9));
    expect(parseWhen('2026-02-31', NOW)).toBeNull();
  });
});

describe('clock and formatting', () => {
  it('parseClock handles 12- and 24-hour forms', () => {
    expect(parseClock('12am')).toEqual([0, 0]);
    expect(parseClock('12pm')).toEqual([12, 0]);
    expect(parseClock('9.30')).toEqual([9, 30]);
    expect(parseClock('13pm')).toBeNull();
    expect(parseClock('9:61')).toBeNull();
  });

  it('whenText names the day relative to now', () => {
    expect(whenText(local(2026, 10, 30, 17, 30), NOW)).toBe('today 17:30');
    expect(whenText(local(2026, 10, 31, 9), NOW)).toBe('tomorrow 09:00');
    expect(whenText(local(2026, 10, 29, 9), NOW)).toBe('yesterday 09:00');
    expect(whenText(local(2026, 11, 3, 9, 5), NOW)).toBe('Tue Nov 3, 09:05');
    expect(whenText(local(2027, 1, 4, 9), NOW)).toBe('Mon Jan 4 2027, 09:00');
  });

  it('tomorrowMorning, clockText and the picker value', () => {
    expect(tomorrowMorning(NOW)).toBe(local(2026, 10, 31, 9));
    expect(clockText(local(2026, 10, 30, 7, 5))).toBe('07:05');
    expect(toLocalInput(local(2026, 10, 30, 7, 5))).toBe('2026-10-30T07:05');
  });
});
