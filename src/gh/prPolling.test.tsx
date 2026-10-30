/**
 * @vitest-environment jsdom
 *
 * A PR whose checks are running is polled every 15 s, any other every 60 s --
 * and the running ones stay polled off screen and with the window hidden.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Task } from '../types';
import {
  PENDING_CALLS_PER_MIN,
  POLL_PENDING_MS,
  POLL_MS,
  pendingIntervalMs,
  refreshPrStatus,
  setPrFetcherForTests,
  usePendingPrWatch,
  usePrPolling,
} from './prStore';
import type { PrStatus } from './prStatus';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const task = (id: number) =>
  ({ id, branch: `b${id}`, baseBranch: 'main', worktreePath: '/w', repoPath: '/r', status: 'idle' }) as unknown as Task;

const pr = (kind: 'pending' | 'passing', state: PrStatus['state'] = 'open'): PrStatus =>
  ({
    number: 1, url: '', title: '', state, headRefName: '', baseRefName: '', headSha: '', mergedAt: null, review: null, lines: [],
    checks: kind === 'pending' ? { kind, pending: 1, total: 1 } : { kind, total: 1 },
  }) as PrStatus;

describe('usePrPolling', () => {
  it('re-asks every 15 s while checks run, and only once a minute otherwise', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const calls: number[] = [];
    setPrFetcherForTests(async (t) => {
      calls.push(t.id);
      return t.id === 1 ? pr('pending') : pr('passing');
    }, () => clock);
    renderHook(() => usePrPolling([task(1), task(2)]));
    await act(async () => {});
    expect(calls.sort()).toEqual([1, 2]);

    calls.length = 0;
    clock += POLL_PENDING_MS;
    await act(async () => {
      vi.advanceTimersByTime(POLL_PENDING_MS);
    });
    expect(calls).toEqual([1]);
  });
});

describe('usePendingPrWatch', () => {
  afterEach(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('keeps every task with running checks polled at the pending rate, on screen or not, even hidden', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const calls: number[] = [];
    // 1: open, checks running. 2: open, passing. 3: merged with running
    // checks (left over). 4: never asked -- the watch adds no first call.
    setPrFetcherForTests(async (t) => {
      calls.push(t.id);
      return t.id === 1 ? pr('pending') : t.id === 3 ? pr('pending', 'merged') : pr('passing');
    }, () => clock);
    for (const id of [1, 2, 3]) await refreshPrStatus(task(id));
    calls.length = 0;

    // Nothing on screen (no usePrPolling), and the window hidden.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    renderHook(() => usePendingPrWatch([task(1), task(2), task(3), task(4)]));
    for (let i = 0; i < 4; i++) {
      clock += POLL_PENDING_MS;
      await act(async () => {
        vi.advanceTimersByTime(POLL_PENDING_MS);
      });
    }
    expect(calls).toEqual([1, 1, 1, 1]);
  });

  it('stops once the checks finish', async () => {
    vi.useFakeTimers();
    let clock = 0;
    let answer = pr('pending');
    const calls: number[] = [];
    setPrFetcherForTests(async (t) => {
      calls.push(t.id);
      return answer;
    }, () => clock);
    await refreshPrStatus(task(1));
    calls.length = 0;
    renderHook(() => usePendingPrWatch([task(1)]));
    answer = pr('passing');
    clock += POLL_PENDING_MS;
    await act(async () => {
      vi.advanceTimersByTime(POLL_PENDING_MS);
    });
    clock += POLL_PENDING_MS;
    await act(async () => {
      vi.advanceTimersByTime(POLL_PENDING_MS);
    });
    expect(calls).toEqual([1]);
  });

  it('stretches the interval to stay within the gh budget when many PRs run', () => {
    expect(pendingIntervalMs(1)).toBe(POLL_PENDING_MS);
    expect(pendingIntervalMs(10)).toBe(POLL_PENDING_MS);
    expect(pendingIntervalMs(20)).toBe(30_000);
    // Never more than the budget a minute, whatever the count.
    for (const n of [5, 11, 37, 100]) expect((n * 60_000) / pendingIntervalMs(n)).toBeLessThanOrEqual(PENDING_CALLS_PER_MIN);
    expect(pendingIntervalMs(100)).toBeLessThan(POLL_MS * 3);
  });
});
