/**
 * @vitest-environment jsdom
 *
 * useTasks against mocked db/capture modules, with fake timers: the bugs here
 * are all about WHEN things happen -- a status window lapsing with no new row,
 * a stale reload landing after a newer status, a failed write never retried.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import type { Message, Task } from '../types';

const h = vi.hoisted(() => ({
  rows: [] as Task[],
  messages: new Map<string, Message[]>(),
  listTasks: null as unknown as () => Promise<Task[]>,
  updateTask: null as unknown as (id: number, patch: Partial<Task>) => Promise<void>,
  captureListeners: new Set<(u: { sessionId: string; cwd: string | null; lastSeq: number }) => void>(),
}));

vi.mock('../db', () => ({
  listTasks: vi.fn(() => h.listTasks()),
  updateTask: vi.fn((id: number, patch: Partial<Task>) => h.updateTask(id, patch)),
  archiveTask: vi.fn(async () => {}),
  getMessages: vi.fn(async (o: { sessionId: string }) => h.messages.get(o.sessionId) ?? []),
  onTasksChanged: vi.fn(() => () => {}),
  compactHistory: vi.fn(async () => {}),
}));
vi.mock('../db/projects', () => ({
  listProjects: vi.fn(async () => []),
  onProjectsChanged: vi.fn(() => () => {}),
}));
vi.mock('../capture', async () => ({
  deriveStatus: (await vi.importActual<typeof import('../capture/status')>('../capture/status')).deriveStatus,
  startCapture: vi.fn(async () => ({ stop: async () => {}, liveUpdatesError: null })),
  onCaptureUpdate: vi.fn((cb: (u: { sessionId: string; cwd: string | null; lastSeq: number }) => void) => {
    h.captureListeners.add(cb);
    return () => h.captureListeners.delete(cb);
  }),
  onCaptureProgress: vi.fn(() => () => {}),
  contextUsageForSessions: vi.fn(async () => new Map()),
}));
vi.mock('../capture/hookEvents', () => ({
  hasHooks: () => false,
  onPromptChange: () => () => {},
  onStatusSnapshot: () => () => {},
  pendingPrompt: () => null,
}));
vi.mock('./attention', () => ({ noteStatusChange: vi.fn(), noteQuestion: vi.fn() }));

const db = await import('../db');
const { noteStatusChange } = await import('./attention');
const { useTasks, reconcileTasks } = await import('./useTasks');
const { RUNNING_WINDOW_MS } = await import('../capture/status');

const T0 = Date.parse('2026-10-19T09:00:00.000Z');

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1, title: 't', projectId: null, repoPath: '/r', baseBranch: 'main', branch: 'b',
    worktreePath: '/wt/1', sessionId: 's1', ownsWorktree: true, createdBranch: true, kind: 'work', status: 'idle',
    createdAt: 0, lastActivityAt: null, ...over,
  };
}

/** A prompt row: recent means `running`, old means `idle`. */
function prompt(sessionId: string, ts: number): Message {
  return {
    id: ts, taskId: 1, sessionId, seq: 0, role: 'user', toolName: null, targetPath: null,
    body: 'go', rawJson: '{}', agentId: null, ts,
  };
}

/** Run timers and let every promise chain they start settle. */
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function emitCapture(sessionId: string, cwd: string | null = null): void {
  for (const cb of [...h.captureListeners]) cb({ sessionId, cwd, lastSeq: 0 });
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  h.rows = [];
  h.messages.clear();
  h.captureListeners.clear();
  // A fresh copy per read, as the real driver returns.
  h.listTasks = async () => h.rows.map((r) => ({ ...r }));
  h.updateTask = async (id, patch) => {
    h.rows = h.rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('status that depends on the clock is re-checked', () => {
  it('re-derives on load: a dead session left `running` in the db reads idle', async () => {
    h.rows = [task({ status: 'running' })];
    h.messages.set('s1', [prompt('s1', T0 - 3_600_000)]);
    const { result } = renderHook(() => useTasks());
    await tick();
    expect(result.current.tasks[0]?.status).toBe('idle');
    expect(db.updateTask).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'idle' }));
  });

  it('flips running to idle when the window lapses with no new row, once', async () => {
    h.rows = [task({ status: 'running' })];
    h.messages.set('s1', [prompt('s1', T0 - 10_000)]);
    const { result, unmount } = renderHook(() => useTasks());
    await tick();
    expect(result.current.tasks[0]?.status).toBe('running');
    expect(noteStatusChange).not.toHaveBeenCalled();

    await tick(RUNNING_WINDOW_MS - 10_000 - 1_000);
    expect(result.current.tasks[0]?.status).toBe('running');

    await tick(2_000);
    expect(result.current.tasks[0]?.status).toBe('idle');
    expect(noteStatusChange).toHaveBeenCalledTimes(1);
    expect(noteStatusChange).toHaveBeenCalledWith(1, 'running', 'idle', 't', null);
    // Re-deriving is not activity: recency stays the newest row's.
    expect(result.current.tasks[0]?.lastActivityAt).toBe(T0 - 10_000);

    await tick(RUNNING_WINDOW_MS * 10);
    expect(noteStatusChange).toHaveBeenCalledTimes(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears a pending expiry on unmount', async () => {
    h.rows = [task({ status: 'running' })];
    h.messages.set('s1', [prompt('s1', T0 - 10_000)]);
    const { unmount } = renderHook(() => useTasks());
    await tick();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a reload keeps unchanged rows', () => {
  it('reconcileTasks returns the previous array and objects when nothing moved', () => {
    const prev = [task(), task({ id: 2, sessionId: 's2' })];
    expect(reconcileTasks(prev, prev.map((t) => ({ ...t })))).toBe(prev);
    const next = reconcileTasks(prev, [{ ...prev[0]!, lastActivityAt: 5 }, { ...prev[1]! }]);
    expect(next).not.toBe(prev);
    expect(next[0]).not.toBe(prev[0]);
    expect(next[1]).toBe(prev[1]);
  });

  it('a refresh with identical rows does not change the tasks identity', async () => {
    h.rows = [task(), task({ id: 2, sessionId: 's2', worktreePath: '/wt/2' })];
    const { result } = renderHook(() => useTasks());
    await tick();
    const before = result.current.tasks;
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.tasks).toBe(before);

    h.rows = [{ ...h.rows[0]!, lastActivityAt: 99 }, h.rows[1]!];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.tasks).not.toBe(before);
    expect(result.current.tasks[1]).toBe(before[1]);
  });
});

describe('a stale reload cannot undo a newer status', () => {
  it('keeps the derived status and announces the transition once', async () => {
    h.rows = [task({ status: 'running' })];
    h.messages.set('s1', [prompt('s1', T0 - 1_000)]);
    const { result } = renderHook(() => useTasks());
    await tick();
    expect(result.current.tasks[0]?.status).toBe('running');

    // A reload starts, reading the row before the status write below lands.
    let release!: (rows: Task[]) => void;
    const staleRows = h.rows.map((r) => ({ ...r }));
    h.listTasks = () => new Promise<Task[]>((resolve) => (release = resolve));
    let reload!: Promise<void>;
    act(() => {
      reload = result.current.refresh();
    });

    // The session goes quiet for good; the capture update re-derives idle.
    h.messages.set('s1', [prompt('s1', T0 - 3_600_000)]);
    emitCapture('s1');
    await tick(300);
    expect(result.current.tasks[0]?.status).toBe('idle');
    expect(noteStatusChange).toHaveBeenCalledTimes(1);

    // The stale read lands now, still saying `running`.
    await act(async () => {
      release(staleRows);
      await reload;
    });
    expect(result.current.tasks[0]?.status).toBe('idle');

    // And the next update sees no transition to announce.
    h.listTasks = async () => h.rows.map((r) => ({ ...r }));
    emitCapture('s1');
    await tick(300);
    expect(noteStatusChange).toHaveBeenCalledTimes(1);
  });
});

describe('failed writes are logged and retried', () => {
  it('retries a failed status write on the next update', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.rows = [task({ status: 'running' })];
    h.messages.set('s1', [prompt('s1', T0 - 3_600_000)]);
    let fail = true;
    const write = h.updateTask;
    h.updateTask = async (id, patch) => {
      if (fail) throw new Error('database is locked');
      await write(id, patch);
    };
    const { result } = renderHook(() => useTasks());
    await tick();
    expect(result.current.tasks[0]?.status).toBe('idle');
    expect(error).toHaveBeenCalled();
    expect(h.rows[0]?.status).toBe('running');

    // A reload while the write is unpersisted must not put `running` back.
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.tasks[0]?.status).toBe('idle');

    fail = false;
    emitCapture('s1');
    await tick(300);
    expect(h.rows[0]?.status).toBe('idle');
    expect(noteStatusChange).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('never adopts a session by folder — the task keeps the session it was given', async () => {
    // The restart bug: any transcript in the task's folder used to become its
    // session. A task is now on its session before `claude` starts.
    h.rows = [task({ sessionId: null, worktreePath: '/wt/9' })];
    h.messages.set('s9', [prompt('s9', T0 - 3_600_000)]);
    const { result } = renderHook(() => useTasks());
    await tick();

    emitCapture('s9', '/wt/9');
    await tick(300);
    expect(result.current.tasks[0]?.sessionId).toBeNull();
    expect(h.rows[0]?.sessionId).toBeNull();
  });
});
