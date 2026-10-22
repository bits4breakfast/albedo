/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

vi.mock('../../capture', () => ({}));

const { WorkingLine, echoIsQueued } = await import('./TranscriptPane');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('WorkingLine', () => {
  it('says Sending, then Working, and counts from the latest activity', () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-10-20T12:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { rerender } = render(<WorkingLine since={t0} sending />);
    expect(screen.getByRole('status').textContent).toBe('Sending · 0s');
    rerender(<WorkingLine since={t0} sending={false} />);
    act(() => {
      vi.advanceTimersByTime(75_000);
    });
    expect(screen.getByRole('status').textContent).toBe('Working · 1m 15s');
  });
});

describe('echoIsQueued', () => {
  const at = new Date('2026-10-20T12:00:00Z').getTime();
  const echo = { text: 'run the tests', at };
  const entry = (text: string, ts: number, injected = false) => ({ text, ts, injected });

  it('finds the message in the queue once Claude Code has queued it', () => {
    expect(echoIsQueued(echo, [])).toBe(false);
    expect(echoIsQueued(echo, [entry('run the tests', at + 300)])).toBe(true);
  });

  it('allows a second of clock slack, and no more', () => {
    expect(echoIsQueued(echo, [entry('run the tests', at - 900)])).toBe(true);
    expect(echoIsQueued(echo, [entry('run the tests', at - 5000)])).toBe(false);
  });

  it('goes by time, not text: Claude Code queues what it made of the input', () => {
    const sent = { text: '/Users/me/Desktop/shot.png hello', at };
    expect(echoIsQueued(sent, [entry('[Image #1] hello', at + 150)])).toBe(true);
  });

  it('does not count what Claude Code queued itself', () => {
    expect(echoIsQueued(echo, [entry('run the tests', at + 10, true)])).toBe(false);
  });
});
