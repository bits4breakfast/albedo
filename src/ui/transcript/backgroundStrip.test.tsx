/**
 * @vitest-environment jsdom
 *
 * The Background band (#122): one line per item, a ticking clock or a
 * countdown, the whole description in the tooltip, a click that asks for
 * the call's row, and nothing at all while nothing runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { BackgroundItem } from '../../capture';

vi.mock('../Terminal', () => ({ usePtyLiveSince: () => null }));
vi.mock('../../db', () => ({ backgroundRowsSince: async () => [] }));

const { BackgroundStrip, backgroundClock } = await import('./BackgroundStrip');

const NOW = Date.parse('2026-10-28T10:10:00.000Z');

const shell: BackgroundItem = {
  key: 't1',
  kind: 'shell',
  description: 'Poll CI until green',
  startedAt: NOW - 192_000,
  until: null,
  rowId: 41,
};
const wake: BackgroundItem = {
  key: 'w1',
  kind: 'wakeup',
  description: 'Timer: wait 5 minutes before the next check',
  startedAt: NOW - 40_000,
  until: NOW + 260_000,
  rowId: 57,
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
      ['Wake-up', 'Timer: wait 5 minutes before the next check', 'in 4m 20s'],
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

describe('backgroundClock', () => {
  it('says how long it has run, or how long until a wake-up', () => {
    expect(backgroundClock(shell, NOW)).toBe('3m 12s');
    expect(backgroundClock(wake, NOW)).toBe('in 4m 20s');
    // A wake-up past its time reads 0 until the next read drops it.
    expect(backgroundClock(wake, NOW + 300_000)).toBe('in 0s');
  });
});
