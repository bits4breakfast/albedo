/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

vi.mock('../../capture', () => ({}));

const { WorkingLine, echoIsQueued, shownQueue } = await import('./TranscriptPane');

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
  /** The pty was spawned a minute before the send. */
  const since = at - 60_000;

  it('finds the message in the queue once Claude Code has queued it', () => {
    expect(echoIsQueued(echo, [], since)).toBe(false);
    expect(echoIsQueued(echo, [entry('run the tests', at + 300)], since)).toBe(true);
  });

  it('allows a second of clock slack, and no more', () => {
    expect(echoIsQueued(echo, [entry('run the tests', at - 900)], since)).toBe(true);
    expect(echoIsQueued(echo, [entry('run the tests', at - 5000)], since)).toBe(false);
  });

  it('goes by time, not text: Claude Code queues what it made of the input', () => {
    const sent = { text: '/Users/me/Desktop/shot.png hello', at };
    expect(echoIsQueued(sent, [entry('[Image #1] hello', at + 150)], since)).toBe(true);
  });

  it('keeps the echo while the band is hidden, so the message is never nowhere', () => {
    const queued = [entry('run the tests', at + 10)];
    // The session is gone: the band hides what it never took, so the echo stays.
    expect(echoIsQueued(echo, queued, null)).toBe(false);
    expect(echoIsQueued(echo, queued, since)).toBe(true);
  });

  it('does not count what Claude Code queued itself', () => {
    expect(echoIsQueued(echo, [entry('run the tests', at + 10, true)], since)).toBe(false);
  });
});

describe('shownQueue', () => {
  const spawned = Date.parse('2026-10-20T12:00:00Z');
  const entry = (text: string, ts: number, injected = false) => ({ text, ts, injected });

  it('shows typed entries whenever the session is alive, idle included', () => {
    // Status is not an input: it reads idle while Claude Code retries a dead
    // connection with your messages still queued (#56).
    expect(shownQueue([entry('waiting', spawned + 5), entry('<task-notification>', spawned + 6, true)], spawned)).toEqual([
      entry('waiting', spawned + 5),
    ]);
  });

  it('hides what a killed session never took', () => {
    expect(shownQueue([entry('never taken', spawned + 5)], null)).toEqual([]);
  });

  it('hides what an earlier process queued: a new or resumed claude starts with an empty queue', () => {
    expect(shownQueue([entry('from the last run', spawned - 1), entry('this run', spawned + 1)], spawned)).toEqual([
      entry('this run', spawned + 1),
    ]);
  });

  it('is the rule the echo hands over by: shown in the band, or kept as the echo, never neither', () => {
    const at = spawned + 10_000;
    for (const queued of [[entry('hello', at + 5)], [entry('hello', spawned - 5)]]) {
      for (const since of [spawned, null]) {
        expect(echoIsQueued({ at: spawned - 10 }, queued, since)).toBe(shownQueue(queued, since).length > 0);
      }
    }
  });
});
