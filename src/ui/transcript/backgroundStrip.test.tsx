/**
 * @vitest-environment jsdom
 *
 * The Background band (#122): one line per item, a ticking clock or a
 * countdown, the whole description in the tooltip, a click that asks for
 * the call's row, and nothing at all while nothing runs. What wakes the task
 * says when, beside its kind (#443).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { BackgroundItem } from '../../capture';

vi.mock('../Terminal', () => ({ usePtyLiveSince: () => null }));
vi.mock('../../db', () => ({ backgroundRowsSince: async () => [] }));

const { BackgroundStrip, backgroundClock } = await import('./BackgroundStrip');
const { clockText } = await import('../../reminders/when');

/** Local noon: every time below falls on the same local day, in any zone. */
const NOW = new Date(2026, 9, 28, 12, 0).getTime();

const shell: BackgroundItem = {
  key: 't1',
  kind: 'shell',
  description: 'Poll CI until green',
  startedAt: NOW - 192_000,
  until: null,
  rowId: 41,
  schedule: null,
  nextRunAt: null,
};
const wake: BackgroundItem = {
  key: 'w1',
  kind: 'wakeup',
  description: 'Timer: wait 5 minutes before the next check',
  startedAt: NOW - 40_000,
  until: NOW + 260_000,
  rowId: 57,
  schedule: null,
  nextRunAt: NOW + 260_000,
};
const MIN = 60_000;
const timer: BackgroundItem = {
  key: 'c1',
  kind: 'timer',
  description: 'Check the error rate since the deploy and report anything above the baseline',
  startedAt: NOW - 2 * 60 * MIN,
  until: NOW + 6 * 24 * 60 * MIN,
  rowId: 12,
  schedule: { cron: '13,43 * * * *', once: false, firstRunAt: NOW - 100 * MIN, createdAt: 0, firedAt: [] },
  nextRunAt: NOW + 21 * MIN,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BackgroundStrip', () => {
  it('is absent while nothing runs', () => {
    const { container } = render(<BackgroundStrip items={[]} onReveal={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('lists each item on one line: kind, description and time; a wake-up counts down', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<BackgroundStrip items={[shell, wake]} onReveal={() => {}} />);
    const band = screen.getByRole('group', { name: 'Running in the background' });
    expect(band.querySelector('.tx-queued-head')?.textContent).toBe('Background 2');
    const lines = screen.getAllByRole('button');
    expect(lines.map((l) => [...l.children].map((c) => c.textContent))).toEqual([
      ['Shell', 'Poll CI until green', '3m 12s'],
      ['Wake-up', clockText(NOW + 260_000), 'Timer: wait 5 minutes before the next check', 'in 4m 20s'],
    ]);
    // The description is cut to one line by CSS; the whole of it is here.
    expect(lines[1]?.getAttribute('title')).toBe('Timer: wait 5 minutes before the next check');
  });

  it('ticks once a second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<BackgroundStrip items={[shell, wake]} onReveal={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText('3m 13s')).toBeTruthy();
    expect(screen.getByText('in 4m 19s')).toBeTruthy();
  });

  it("asks for the starting call's row on a click", () => {
    const onReveal = vi.fn();
    render(<BackgroundStrip items={[shell, wake]} onReveal={onReveal} />);
    fireEvent.click(screen.getByText('Timer: wait 5 minutes before the next check'));
    expect(onReveal).toHaveBeenCalledWith(57);
  });
});

describe('BackgroundStrip: what wakes the task (#443)', () => {
  it('leads a timer with its schedule and next run, then the prompt, then the countdown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<BackgroundStrip items={[timer]} onReveal={() => {}} />);
    const line = screen.getByRole('button');
    expect([...line.children].map((c) => [c.className, c.textContent])).toEqual([
      ['tx-background-kind', 'Timer'],
      ['tx-background-when', `every 30 min · next ${clockText(NOW + 21 * MIN)}`],
      ['tx-background-desc', timer.description],
      ['tx-background-time', 'in 21m 0s'],
    ]);
    expect(line.getAttribute('data-when')).toBe('true');
    expect(line.getAttribute('title')).toBe(timer.description);
  });

  it('says "once" for a one-shot, and only the next time for an uneven cron', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const once = { ...timer, key: 'c2', schedule: { cron: '0 15 * * *', once: true, firstRunAt: NOW + 68 * MIN, createdAt: 0, firedAt: [] }, nextRunAt: NOW + 68 * MIN };
    const uneven = { ...timer, key: 'c3', schedule: { cron: '0 9,13,17 * * 1-5', once: false, firstRunAt: null, createdAt: 0, firedAt: [] }, nextRunAt: NOW + 188 * MIN };
    render(<BackgroundStrip items={[once, uneven]} onReveal={() => {}} />);
    const whens = [...document.querySelectorAll('.tx-background-when')].map((e) => e.textContent);
    expect(whens).toEqual([`once · ${clockText(NOW + 68 * MIN)}`, `next ${clockText(NOW + 188 * MIN)}`]);
  });

  it('keeps a timer whose next run is not known as before: kind, prompt, age', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<BackgroundStrip items={[{ ...timer, nextRunAt: null }]} onReveal={() => {}} />);
    const line = screen.getByRole('button');
    expect([...line.children].map((c) => c.textContent)).toEqual(['Timer', timer.description, '2h 0m']);
    expect(line.getAttribute('data-when')).toBeNull();
  });
});

describe('backgroundClock', () => {
  it('says how long it has run, or how long until a wake-up', () => {
    expect(backgroundClock(shell, NOW)).toBe('3m 12s');
    expect(backgroundClock(wake, NOW)).toBe('in 4m 20s');
    // A wake-up past its time reads 0 until the next read drops it.
    expect(backgroundClock(wake, NOW + 300_000)).toBe('in 0s');
    // A run on another day: the day and time beside it say it.
    const nextDay = new Date(NOW);
    nextDay.setDate(nextDay.getDate() + 2);
    expect(backgroundClock({ ...timer, nextRunAt: nextDay.getTime() }, NOW)).toBe('');
    // By distance, not calendar day: a wake-up at 00:10 seen at 23:50.
    const lateNight = new Date(2026, 9, 28, 23, 50).getTime();
    const pastMidnight = new Date(2026, 9, 29, 0, 10).getTime();
    expect(backgroundClock({ ...wake, until: pastMidnight, nextRunAt: pastMidnight }, lateNight)).toBe('in 20m 0s');
    expect(backgroundClock({ ...timer, nextRunAt: lateNight + 11 * 60 * MIN }, lateNight)).toBe('in 11h 0m');
    expect(backgroundClock({ ...timer, nextRunAt: lateNight + 12 * 60 * MIN }, lateNight)).toBe('');
  });
});
