/**
 * @vitest-environment jsdom
 *
 * `useKeepAwake` (#283): tells Rust only when holding starts, stops or its
 * reason changes; releases when switched off and when unmounted; re-reads at
 * a wake-up's due time with no tick. And the switch, remembered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Message, Task } from '../types';
import { parseLine } from '../capture/adapter';
import { backgroundShell, wakeup } from '../capture/backgroundFixtures';

const calls: { on: boolean; reason: string }[] = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: { on: boolean; reason: string }) => {
    if (cmd === 'set_keep_awake') calls.push(args);
  },
}));

const live = new Map<number, number>();
const presence = new Set<(id: number, live: boolean) => void>();
vi.mock('./Terminal', () => ({
  ptyLiveSince: (id: number) => live.get(id) ?? null,
  onPtyPresenceChange: (cb: (id: number, live: boolean) => void) => {
    presence.add(cb);
    return () => presence.delete(cb);
  },
}));

let background: Record<string, unknown>[] = [];
/** Sessions looked up, in order. */
const lookups: string[] = [];
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  backgroundRowsSince: async (sessionId: string): Promise<Message[]> => {
    lookups.push(sessionId);
    return background.flatMap((line, i) => parseLine(JSON.stringify(line), i).map((m) => ({ ...m, id: i + 1, taskId: 1, agentId: null })));
  },
}));

const { useKeepAwake, keepAwakeEnabled, setKeepAwakeEnabled } = await import('./keepAwake');
const { KEYS } = await import('./persisted');

const base = {
  projectId: 1, repoPath: '/r/app', createdBranch: false, kind: 'work', baseBranch: 'main',
  ownsWorktree: true, createdAt: 1, lastActivityAt: 1, seenAt: null, summary: null, reviewUrl: null, apiError: null, apiErrorText: null, spunFromTaskId: null,
  branch: 'b', worktreePath: '/w/b', title: 'T',
} as const;
const mk = (id: number, status: Task['status']): Task => ({ ...base, id, status, sessionId: `s${id}` });

let data: Map<string, string>;
beforeEach(() => {
  calls.length = 0;
  lookups.length = 0;
  live.clear();
  background = [];
  data = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useKeepAwake', () => {
  it('holds while a task runs, only on transitions, and releases when none does', async () => {
    const { result, rerender } = renderHook(({ tasks, on }) => useKeepAwake(tasks, on), {
      initialProps: { tasks: [mk(1, 'idle')], on: true },
    });
    await act(async () => {});
    expect(calls).toEqual([]);
    expect(result.current).toBe(0);

    rerender({ tasks: [mk(1, 'running')], on: true });
    await act(async () => {});
    expect(calls).toEqual([{ on: true, reason: '1 Claude Code task running' }]);
    expect(result.current).toBe(1);

    // The same answer again (a new task array, same statuses): no call.
    rerender({ tasks: [mk(1, 'running'), mk(2, 'idle')], on: true });
    await act(async () => {});
    expect(calls).toHaveLength(1);

    // A second one: the reason follows the count.
    rerender({ tasks: [mk(1, 'running'), mk(2, 'running')], on: true });
    await act(async () => {});
    expect(calls.at(-1)).toEqual({ on: true, reason: '2 Claude Code tasks running' });

    rerender({ tasks: [mk(1, 'idle'), mk(2, 'done')], on: true });
    await act(async () => {});
    expect(calls.at(-1)).toEqual({ on: false, reason: '' });
    expect(calls).toHaveLength(3);
    expect(result.current).toBe(0);
  });

  it('releases at once when switched off, and on unmount', async () => {
    const { result, rerender, unmount } = renderHook(({ tasks, on }) => useKeepAwake(tasks, on), {
      initialProps: { tasks: [mk(1, 'running')], on: true },
    });
    await act(async () => {});
    expect(calls).toEqual([{ on: true, reason: '1 Claude Code task running' }]);

    rerender({ tasks: [mk(1, 'running')], on: false });
    await act(async () => {});
    expect(calls.at(-1)).toEqual({ on: false, reason: '' });
    expect(result.current).toBe(0);

    rerender({ tasks: [mk(1, 'running')], on: true });
    await act(async () => {});
    expect(calls.at(-1)?.on).toBe(true);
    unmount();
    await act(async () => {});
    expect(calls.at(-1)).toEqual({ on: false, reason: '' });
    expect(calls).toHaveLength(4);
  });

  it('holds for background work on a live terminal, and lets go when a wake-up falls due', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const spawned = Date.now() - 60_000;
    live.set(1, spawned);
    background = wakeup('w1', spawned + 1_000, 120);
    const due = spawned + 1_000 + 120_000;

    const { result } = renderHook(() => useKeepAwake([mk(1, 'idle')], true));
    await act(async () => {});
    expect(result.current).toBe(1);
    expect(calls).toEqual([{ on: true, reason: '1 Claude Code task running' }]);

    await act(async () => {
      vi.advanceTimersByTime(due - Date.now() + 5);
    });
    expect(result.current).toBe(0);
    expect(calls.at(-1)).toEqual({ on: false, reason: '' });
  });

  it('counts nothing in the background until the terminal is live', async () => {
    background = backgroundShell('t1', 'b1', Date.now() - 1_000);
    const { result } = renderHook(() => useKeepAwake([mk(1, 'idle')], true));
    await act(async () => {});
    expect(result.current).toBe(0);

    live.set(1, Date.now() - 60_000);
    act(() => {
      for (const cb of presence) cb(1, true);
    });
    await waitFor(() => expect(result.current).toBe(1));
  });
});

describe('switched off (#364)', () => {
  it('looks nothing up, and counts background work again once switched on', async () => {
    const spawned = Date.now() - 60_000;
    live.set(1, spawned);
    background = backgroundShell('t1', 'b1', spawned + 1_000);
    const { result, rerender } = renderHook(({ tasks, on }) => useKeepAwake(tasks, on), {
      initialProps: { tasks: [mk(1, 'idle')], on: false },
    });
    await act(async () => {});
    expect(lookups).toEqual([]);
    expect(result.current).toBe(0);
    expect(calls).toEqual([]);

    // Tasks change, a terminal comes and goes: still nothing to look up.
    rerender({ tasks: [mk(1, 'idle'), mk(2, 'idle')], on: false });
    live.set(2, spawned);
    act(() => {
      for (const cb of presence) cb(2, true);
    });
    await act(async () => {});
    expect(lookups).toEqual([]);

    // Both terminals are live, and both sessions have the shell running.
    rerender({ tasks: [mk(1, 'idle'), mk(2, 'idle')], on: true });
    await waitFor(() => expect(result.current).toBe(2));
    expect([...lookups].sort()).toEqual(['s1', 's2']);
    expect(calls.at(-1)).toEqual({ on: true, reason: '2 Claude Code tasks running' });
  });

  it('switched off while holding for background work: released, and its lookups stop', async () => {
    const spawned = Date.now() - 60_000;
    live.set(1, spawned);
    background = backgroundShell('t1', 'b1', spawned + 1_000);
    const { result, rerender } = renderHook(({ tasks, on }) => useKeepAwake(tasks, on), {
      initialProps: { tasks: [mk(1, 'idle')], on: true },
    });
    await waitFor(() => expect(result.current).toBe(1));
    lookups.length = 0;

    rerender({ tasks: [mk(1, 'idle')], on: false });
    await act(async () => {});
    expect(result.current).toBe(0);
    expect(calls.at(-1)).toEqual({ on: false, reason: '' });
    rerender({ tasks: [{ ...mk(1, 'idle'), title: 'renamed' }], on: false });
    await act(async () => {});
    expect(lookups).toEqual([]);
  });

  it('a running task holds at once when switched on, before any lookup lands', async () => {
    const { result, rerender } = renderHook(({ tasks, on }) => useKeepAwake(tasks, on), {
      initialProps: { tasks: [mk(1, 'running')], on: false },
    });
    await act(async () => {});
    expect(calls).toEqual([]);
    rerender({ tasks: [mk(1, 'running')], on: true });
    expect(result.current).toBe(1);
    await act(async () => {});
    expect(calls).toEqual([{ on: true, reason: '1 Claude Code task running' }]);
  });
});

describe('the switch', () => {
  it('is on by default, remembered off, and back on', () => {
    expect(keepAwakeEnabled()).toBe(true);
    setKeepAwakeEnabled(false);
    expect(data.get(KEYS.keepAwake)).toBe('off');
    expect(keepAwakeEnabled()).toBe(false);
    setKeepAwakeEnabled(true);
    expect(data.has(KEYS.keepAwake)).toBe(false);
    expect(keepAwakeEnabled()).toBe(true);
  });
});
