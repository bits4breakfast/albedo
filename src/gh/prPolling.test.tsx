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
  POLL_MERGED_QUIET_MS,
  POLL_NO_PR_QUIET_MS,
  POLL_PENDING_MS,
  POLL_MS,
  getPrStatus,
  pendingIntervalMs,
  pollEveryMs,
  refreshPrStatus,
  setPrFetcherForTests,
  usePendingPrWatch,
  usePrPolling,
} from './prStore';
import type { PrStatus } from './prStatus';
import { PR_FETCH_FAILED } from './gh';

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

describe('usePrPolling: quiet branches with no PR or a merged one (#365)', () => {
  /** Run the on-screen poll for `ms`, a tick at a time, and return who was asked. */
  async function pollFor(tasks: () => Task[], ms: number, clock: { now: number }, calls: number[]) {
    const { rerender } = renderHook(() => usePrPolling(tasks()));
    await act(async () => {});
    calls.length = 0;
    for (let t = 0; t < ms; t += POLL_PENDING_MS) {
      clock.now += POLL_PENDING_MS;
      rerender();
      await act(async () => {
        vi.advanceTimersByTime(POLL_PENDING_MS);
      });
    }
  }

  it('asks a quiet branch with no PR every five minutes once two answers said none, an open PR every minute as before', async () => {
    vi.useFakeTimers();
    const clock = { now: 1_000_000 };
    const calls: number[] = [];
    setPrFetcherForTests(async (t) => {
      calls.push(t.id);
      return t.id === 1 ? null : pr('passing');
    }, () => clock.now);
    const quiet = { ...task(1), lastActivityAt: clock.now - 10_000 } as Task;
    // One "none" is not enough (search can lag a PR just opened): asked
    // again after a minute, and only then every five.
    await pollFor(() => [quiet, task(2)], POLL_MS + POLL_NO_PR_QUIET_MS, clock, calls);
    expect(calls.filter((id) => id === 1)).toEqual([1, 1]);
    expect(calls.filter((id) => id === 2)).toHaveLength((POLL_MS + POLL_NO_PR_QUIET_MS) / POLL_MS);
  });

  it('asks a quiet merged PR every fifteen minutes', async () => {
    vi.useFakeTimers();
    const clock = { now: 1_000_000 };
    const calls: number[] = [];
    setPrFetcherForTests(async (t) => {
      calls.push(t.id);
      return pr('passing', 'merged');
    }, () => clock.now);
    const merged = { ...task(1), lastActivityAt: null } as Task;
    await pollFor(() => [merged], POLL_MS + POLL_MERGED_QUIET_MS, clock, calls);
    expect(calls).toEqual([1, 1]);
  });

  it('asks a branch with no PR every minute again once its session writes', async () => {
    vi.useFakeTimers();
    const clock = { now: 1_000_000 };
    const calls: number[] = [];
    setPrFetcherForTests(async (t) => {
      calls.push(t.id);
      return null;
    }, () => clock.now);
    let activity: number | null = null;
    const current = () => [{ ...task(1), lastActivityAt: activity } as Task];
    const { rerender } = renderHook(() => usePrPolling(current()));
    await act(async () => {});
    // The second "none", a minute later.
    for (let i = 0; i < 4; i++) {
      clock.now += POLL_PENDING_MS;
      rerender();
      await act(async () => {
        vi.advanceTimersByTime(POLL_PENDING_MS);
      });
    }
    expect(calls).toEqual([1, 1]);
    calls.length = 0;
    // Quiet for two minutes: not asked.
    for (let i = 0; i < 8; i++) {
      clock.now += POLL_PENDING_MS;
      rerender();
      await act(async () => {
        vi.advanceTimersByTime(POLL_PENDING_MS);
      });
    }
    expect(calls).toEqual([]);
    // A turn writes (it may have opened a PR): asked on the next tick, the
    // last answer being over a minute old.
    activity = clock.now;
    clock.now += POLL_PENDING_MS;
    rerender();
    await act(async () => {
      vi.advanceTimersByTime(POLL_PENDING_MS);
    });
    expect(calls).toEqual([1]);
  });

  it('counts activity from when the question was sent, not answered', () => {
    const asked = 1_000;
    const e = (p: PrStatus | null, more: { failed?: boolean; streak?: number } = {}) => ({
      pr: p,
      askedAt: asked,
      failed: more.failed ?? false,
      streak: more.streak ?? 2,
    });
    // A PR opened while gh was on its way may not be in the answer.
    expect(pollEveryMs(e(null), { lastActivityAt: asked + 1 })).toBe(POLL_MS);
    expect(pollEveryMs(e(null), { lastActivityAt: asked })).toBe(POLL_NO_PR_QUIET_MS);
    expect(pollEveryMs(e(null), { lastActivityAt: null })).toBe(POLL_NO_PR_QUIET_MS);
    expect(pollEveryMs(e(pr('passing', 'merged')), { lastActivityAt: 0 })).toBe(POLL_MERGED_QUIET_MS);
    // One answer alone, or a failed ask: the minute.
    expect(pollEveryMs(e(null, { streak: 1 }), { lastActivityAt: null })).toBe(POLL_MS);
    expect(pollEveryMs(e(pr('passing', 'merged'), { streak: 1 }), { lastActivityAt: null })).toBe(POLL_MS);
    expect(pollEveryMs(e(null, { failed: true }), { lastActivityAt: null })).toBe(POLL_MS);
    // Unchanged: an open or closed PR, and a task whose activity is unknown.
    expect(pollEveryMs(e(pr('passing')), { lastActivityAt: 0 })).toBe(POLL_MS);
    expect(pollEveryMs(e(pr('passing', 'closed')), { lastActivityAt: 0 })).toBe(POLL_MS);
    expect(pollEveryMs(e(null), {})).toBe(POLL_MS);
  });

  it('keeps the last answer when gh fails, and asks again on the minute (#365 review)', async () => {
    vi.useFakeTimers();
    const clock = { now: 1_000_000 };
    const calls: number[] = [];
    let answer: PrStatus | null | typeof PR_FETCH_FAILED = pr('passing');
    setPrFetcherForTests(async (t) => {
      calls.push(t.id);
      return answer;
    }, () => clock.now);
    const quiet = { ...task(1), lastActivityAt: null } as Task;
    renderHook(() => usePrPolling([quiet]));
    await act(async () => {});
    expect(getPrStatus(1)?.number).toBe(1);
    // Offline: the open PR stays, not "no PR".
    answer = PR_FETCH_FAILED;
    await pollFor(() => [quiet], POLL_MS, clock, calls);
    expect(calls).toEqual([1]);
    expect(getPrStatus(1)?.number).toBe(1);
    // Still failing: asked every minute, never backed off.
    await pollFor(() => [quiet], 3 * POLL_MS, clock, calls);
    expect(calls).toEqual([1, 1, 1]);
    // Back: the answer comes through.
    answer = null;
    await pollFor(() => [quiet], POLL_MS, clock, calls);
    expect(calls).toEqual([1]);
    expect(getPrStatus(1)).toBeNull();
  });

  it('reads a failure with nothing to keep as "none", as before, and does not back off on it', async () => {
    vi.useFakeTimers();
    const clock = { now: 1_000_000 };
    const calls: number[] = [];
    setPrFetcherForTests(async (t) => {
      calls.push(t.id);
      return PR_FETCH_FAILED;
    }, () => clock.now);
    const quiet = { ...task(1), lastActivityAt: null } as Task;
    await pollFor(() => [quiet], 3 * POLL_MS, clock, calls);
    expect(getPrStatus(1)).toBeNull();
    expect(calls).toEqual([1, 1, 1]);
  });

  it('still catches a quiet branch up on focus', async () => {
    vi.useFakeTimers();
    const clock = { now: 1_000_000 };
    const calls: number[] = [];
    setPrFetcherForTests(async (t) => {
      calls.push(t.id);
      return null;
    }, () => clock.now);
    renderHook(() => usePrPolling([{ ...task(1), lastActivityAt: null } as Task]));
    await act(async () => {});
    calls.length = 0;
    clock.now += 20_000;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
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
