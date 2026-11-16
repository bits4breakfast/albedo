/**
 * @vitest-environment jsdom
 *
 * When the status strip reads the token figures again (#365). They used to
 * be read every 30 s whatever happened; now not while the window is hidden
 * (caught up when it shows), and not when nothing could have changed them:
 * no capture update, no deleted messages, and no counted turn old enough to
 * leave a window. Any of those, and the next tick reads as before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

import type { WindowUsage } from '../capture';

const cap = vi.hoisted(() => ({
  onUpdate: null as null | (() => void),
  usage: null as null | ((kind: '5h' | 'week') => Promise<WindowUsage>),
  deletions: 0,
}));
vi.mock('../capture', () => ({
  onCaptureUpdate: (cb: () => void) => {
    cap.onUpdate = cb;
    return () => {
      cap.onUpdate = null;
    };
  },
  windowUsage: vi.fn((kind: '5h' | 'week') => cap.usage!(kind)),
}));
vi.mock('../capture/hookEvents', () => ({ onStatusSnapshot: () => () => {}, planUsage: () => null }));
vi.mock('../db', async () => ({ ...(await vi.importActual('../db')), messageDeletions: () => cap.deletions }));

const { windowUsage } = await import('../capture');
const { default: StatusBar, unchangedUntil } = await import('./StatusBar');

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

/** A window whose oldest counted turn ages out at `end`. */
const w = (end: number, now = T0): WindowUsage => ({
  windowStart: 0,
  windowEnd: end,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 1,
  resetsInMs: Math.max(0, end - now),
  burnRate: 0,
});

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  cap.deletions = 0;
  cap.usage = async (kind) => (kind === '5h' ? w(T0 + 2 * HOUR) : w(T0 + 3 * 24 * HOUR));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});

const reads = () => vi.mocked(windowUsage).mock.calls.length / 2;
const tick = (ms = 30_000) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
  });

describe('StatusBar: when the token figures are read (#365)', () => {
  it('reads on mount, then not while nothing could have changed them', async () => {
    render(<StatusBar />);
    await tick(0);
    expect(reads()).toBe(1);
    await tick();
    await tick();
    expect(reads()).toBe(1);
  });

  it('reads on the next tick once a turn is old enough to leave the five-hour window', async () => {
    cap.usage = async (kind) => (kind === '5h' ? w(T0 + 45_000) : w(T0 + 3 * 24 * HOUR));
    render(<StatusBar />);
    await tick(0);
    await tick(); // T0 + 30 s: still counted
    expect(reads()).toBe(1);
    await tick(); // T0 + 60 s: gone
    expect(reads()).toBe(2);
  });

  it('reads after a capture update, as before, at most every 15 s', async () => {
    render(<StatusBar />);
    await tick(0);
    act(() => cap.onUpdate?.());
    await tick(15_000);
    expect(reads()).toBe(2);
  });

  it('reads after messages were deleted', async () => {
    render(<StatusBar />);
    await tick(0);
    cap.deletions = 1;
    await tick();
    expect(reads()).toBe(2);
  });

  it('reads every tick while a window is empty or a read failed, as before', async () => {
    cap.usage = async (kind) => (kind === '5h' ? w(T0) : w(T0 + 3 * 24 * HOUR));
    render(<StatusBar />);
    await tick(0);
    await tick();
    await tick();
    expect(reads()).toBe(3);
    expect(unchangedUntil(null, w(T0 + HOUR))).toBe(-Infinity);
    expect(unchangedUntil(w(T0 + HOUR), w(T0 + 2 * HOUR))).toBe(T0 + HOUR);
  });

  it('reads nothing while hidden, and catches up when shown', async () => {
    render(<StatusBar />);
    await tick(0);
    hidden = true;
    act(() => cap.onUpdate?.());
    await tick(15_000);
    await tick();
    await tick();
    expect(reads()).toBe(1);
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(reads()).toBe(2);
  });
});
