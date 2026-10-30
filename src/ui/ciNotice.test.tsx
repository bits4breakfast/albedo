/**
 * @vitest-environment jsdom
 *
 * Checks finishing (#159): a banner and a bounce when away, a row mark when
 * here, a cue on the open task's badge -- and the setting that silences the
 * loud half.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { __setAttentionBackend, lastBannerFor, NOTIFICATIONS_KEY } from './attention';
import {
  CI_CUE_MS,
  ciCueFor,
  ciMarkFor,
  ciNotifyEnabled,
  observeCi,
  requestChecks,
  resetCiNoticesForTests,
  setCiNotifyEnabled,
  takeChecksRequest,
  useCiNotices,
} from './ciNotice';
import { parsePrView, type PrStatus } from '../gh/prStatus';
import { refreshPrStatus, setPrFetcherForTests } from '../gh/prStore';
import type { Task } from '../types';

function pr(sha: string, conclusion: 'SUCCESS' | 'FAILURE' | null): PrStatus {
  return parsePrView(
    JSON.stringify({
      number: 12,
      state: 'OPEN',
      headRefName: 'b',
      headRefOid: sha,
      statusCheckRollup: [
        conclusion
          ? { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion }
          : { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' },
      ],
    }),
  ) as PrStatus;
}
const running = (sha = 'a') => pr(sha, null);
const passed = (sha = 'a') => pr(sha, 'SUCCESS');
const failed = (sha = 'a') => pr(sha, 'FAILURE');

const T = { id: 7, title: 'Fix login' };

let bounces: boolean[];
let posted: { title: string; body: string; taskId: number }[];
function backend(focused: boolean) {
  bounces = [];
  posted = [];
  __setAttentionBackend((c) => bounces.push(c), focused, (n) => posted.push(n));
}

beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  resetCiNoticesForTests();
  backend(false);
});
afterEach(() => {
  cleanup();
  __setAttentionBackend(null);
  vi.useRealTimers();
});

describe('observeCi', () => {
  it('away: a failure bounces once, posts the failing job, and marks the row', () => {
    observeCi(T, running(), null);
    observeCi(T, failed(), null);
    expect(bounces).toEqual([false]);
    expect(posted).toEqual([{ title: '✗ Checks failed: Fix login (#12)', body: 'test', taskId: 7 }]);
    expect(ciMarkFor(7)).toEqual({ outcome: 'fail', prNumber: 12, job: 'test' });
    expect(lastBannerFor(7)).toBe('checks-fail');
  });

  it('away: a pass bounces and posts too', () => {
    observeCi(T, running(), null);
    observeCi(T, passed(), null);
    expect(bounces).toEqual([false]);
    expect(posted[0]?.title).toBe('✓ Checks passed: Fix login (#12)');
    expect(lastBannerFor(7)).toBe('checks-pass');
  });

  it('focused: no banner and no bounce, only the row mark', () => {
    backend(true);
    observeCi(T, running(), null);
    observeCi(T, passed(), null);
    expect(bounces).toEqual([]);
    expect(posted).toEqual([]);
    expect(ciMarkFor(7)?.outcome).toBe('pass');
  });

  it('the open task gets a brief cue on its badge, not a row mark', () => {
    vi.useFakeTimers();
    backend(true);
    observeCi(T, running(), 7);
    observeCi(T, failed(), 7);
    expect(ciMarkFor(7)).toBeUndefined();
    expect(ciCueFor(7)).toBe('fail');
    expect(ciCueFor(8)).toBeNull();
    vi.advanceTimersByTime(CI_CUE_MS);
    expect(ciCueFor(7)).toBeNull();
  });

  it('nothing for a result already final at launch', () => {
    observeCi(T, failed(), null);
    observeCi(T, failed(), null);
    expect(posted).toEqual([]);
    expect(ciMarkFor(7)).toBeUndefined();
  });

  it('"Notify When CI Finishes" off: no banner, no bounce; the mark stays', () => {
    setCiNotifyEnabled(false);
    expect(ciNotifyEnabled()).toBe(false);
    observeCi(T, running(), null);
    observeCi(T, failed(), null);
    expect(bounces).toEqual([]);
    expect(posted).toEqual([]);
    expect(ciMarkFor(7)?.outcome).toBe('fail');
  });

  it('respects the app-wide banner switch', () => {
    window.localStorage.setItem(NOTIFICATIONS_KEY, 'off');
    observeCi(T, running(), null);
    observeCi(T, passed(), null);
    expect(bounces).toEqual([false]);
    expect(posted).toEqual([]);
  });

  it('a new push clears a mark about the commit before it', () => {
    observeCi(T, running('a'), null);
    observeCi(T, failed('a'), null);
    expect(ciMarkFor(7)).toBeDefined();
    observeCi(T, running('b'), null);
    expect(ciMarkFor(7)).toBeUndefined();
  });
});

describe('checks request', () => {
  it('is taken once, and only by its task', () => {
    requestChecks(7);
    expect(takeChecksRequest(8)).toBe(false);
    expect(takeChecksRequest(7)).toBe(true);
    expect(takeChecksRequest(7)).toBe(false);
  });
});

describe('useCiNotices', () => {
  const task = (id: number, over: Partial<Task> = {}) =>
    ({ id, title: `T${id}`, status: 'idle', kind: 'work', branch: `b${id}`, baseBranch: 'main', worktreePath: '/w', repoPath: '/r', ...over }) as Task;

  it('watches every task the PR store answers for, and clears the mark when the task is opened', async () => {
    let answer = running();
    setPrFetcherForTests(async () => answer);
    const { rerender } = renderHook(({ sel }) => useCiNotices([task(1), task(2, { status: 'archived' })], sel), {
      initialProps: { sel: null as number | null },
    });
    await act(async () => {
      await refreshPrStatus(task(1));
      await refreshPrStatus(task(2));
    });
    answer = failed();
    await act(async () => {
      await refreshPrStatus(task(1), { force: true });
      await refreshPrStatus(task(2), { force: true });
    });
    expect(ciMarkFor(1)?.outcome).toBe('fail');
    // Archived: not watched.
    expect(ciMarkFor(2)).toBeUndefined();
    expect(posted.map((n) => n.taskId)).toEqual([1]);

    rerender({ sel: 1 });
    expect(ciMarkFor(1)).toBeUndefined();
  });
});
