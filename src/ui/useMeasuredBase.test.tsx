/**
 * @vitest-environment jsdom
 *
 * The stack check behind the measured base (#365): every reader of a task
 * shares one entry, one minute timer and one focus listener, and nothing is
 * asked while the PR names the base, since the PR's base outranks a stack.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import type { PrStatus } from '../gh/prStatus';
import type { Task } from '../types';

const prs = vi.hoisted(() => ({ current: null as PrStatus | null }));
vi.mock('../gh/prStore', () => ({
  usePrStatus: () => prs.current,
  getPrStatus: () => prs.current,
}));
const detect = vi.hoisted(() => vi.fn(async (): Promise<{ base: string; how: 'on' | 'older' } | null> => null));
vi.mock('../git/stackBase', () => ({ detectStackBase: detect }));

import { STACK_POLL_MS, stackStoreStateForTests, useMeasuredBase, useStackBase } from './useMeasuredBase';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  detect.mockReset();
  detect.mockImplementation(async () => null);
  prs.current = null;
});

const task = (over: Partial<Task> = {}) =>
  ({ id: 1, kind: 'work', status: 'idle', repoPath: '/r', worktreePath: '/w', branch: 'fix-login', baseBranch: 'main', ...over }) as Task;

/** Let the looks in flight answer. */
const flush = () => act(async () => {});

describe('useStackBase: one store for every reader (#365)', () => {
  it('asks once a minute for a task however many readers mounted, and when', async () => {
    vi.useFakeTimers();
    const t = task();
    renderHook(() => useStackBase(t));
    await flush();
    expect(detect).toHaveBeenCalledTimes(1);
    // The Files pane opens 20 s later: it asks for a look of its own time...
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    renderHook(() => useMeasuredBase(t));
    renderHook(() => useStackBase(t));
    await flush();
    expect(detect).toHaveBeenCalledTimes(2);
    // ...but the minute after is one look, not one per reader.
    await act(async () => {
      vi.advanceTimersByTime(STACK_POLL_MS);
    });
    await flush();
    expect(detect).toHaveBeenCalledTimes(3);
    expect(stackStoreStateForTests()).toEqual({ timers: 1, entries: 1 });
  });

  it('hands every reader the same answer, and a new reader the known one at once', async () => {
    detect.mockImplementation(async () => ({ base: 'add-export', how: 'on' }));
    const t = task();
    const a = renderHook(() => useStackBase(t));
    await flush();
    expect(a.result.current).toEqual({ base: 'add-export', how: 'on' });
    const b = renderHook(() => useMeasuredBase(t));
    expect(b.result.current.base).toBe('add-export');
    expect(b.result.current.target).toEqual({ base: 'add-export', from: 'stack' });
  });

  it('looks again on focus, once for all readers', async () => {
    const t = task();
    renderHook(() => useStackBase(t));
    renderHook(() => useStackBase(t));
    await flush();
    detect.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('stops the timer once the last reader goes', async () => {
    const t = task();
    const a = renderHook(() => useStackBase(t));
    const b = renderHook(() => useStackBase(task({ id: 2 })));
    await flush();
    expect(stackStoreStateForTests()).toEqual({ timers: 1, entries: 2 });
    a.unmount();
    expect(stackStoreStateForTests()).toEqual({ timers: 1, entries: 1 });
    b.unmount();
    expect(stackStoreStateForTests()).toEqual({ timers: 0, entries: 0 });
  });

  it('asks nothing while the PR names the base, which wins anyway', async () => {
    vi.useFakeTimers();
    prs.current = { number: 7, baseRefName: 'release' } as PrStatus;
    const t = task();
    const { result } = renderHook(() => useMeasuredBase(t));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(3 * STACK_POLL_MS);
    });
    expect(detect).not.toHaveBeenCalled();
    expect(result.current.base).toBe('release');
    expect(result.current.target).toEqual({ base: 'release', from: 'pr' });
  });

  it('asks again once the PR no longer names a base', async () => {
    detect.mockImplementation(async () => ({ base: 'add-export', how: 'older' }));
    prs.current = { number: 7, baseRefName: 'release' } as PrStatus;
    const t = task();
    const { result, rerender } = renderHook(() => useMeasuredBase(t));
    await flush();
    expect(detect).not.toHaveBeenCalled();
    prs.current = null;
    rerender();
    await flush();
    expect(detect).toHaveBeenCalledTimes(1);
    // On an older copy: measured against the stored base, the header says so.
    expect(result.current.base).toBe('main');
    expect(result.current.target).toEqual({ base: 'add-export', from: 'older' });
  });

  it('asks nothing for a chat, an archived task or a task with no branch', async () => {
    for (const t of [task({ kind: 'chat' }), task({ status: 'archived' }), task({ branch: '' })]) {
      renderHook(() => useMeasuredBase(t));
    }
    await flush();
    expect(detect).not.toHaveBeenCalled();
    expect(stackStoreStateForTests()).toEqual({ timers: 0, entries: 0 });
  });

  it('does not look while the window is hidden', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      vi.useFakeTimers();
      renderHook(() => useStackBase(task()));
      await act(async () => {
        vi.advanceTimersByTime(STACK_POLL_MS);
      });
      expect(detect).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    }
  });
});
