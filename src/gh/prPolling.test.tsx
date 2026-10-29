/**
 * @vitest-environment jsdom
 *
 * A PR whose checks are running is polled every 15 s, any other every 60 s.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Task } from '../types';
import { POLL_PENDING_MS, setPrFetcherForTests, usePrPolling } from './prStore';
import type { PrStatus } from './prStatus';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const task = (id: number) =>
  ({ id, branch: `b${id}`, baseBranch: 'main', worktreePath: '/w', repoPath: '/r', status: 'idle' }) as unknown as Task;

const pr = (kind: 'pending' | 'passing'): PrStatus =>
  ({
    number: 1, url: '', title: '', state: 'open', headRefName: '', baseRefName: '', mergedAt: null, review: null, lines: [],
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
