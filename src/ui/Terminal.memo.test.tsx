/**
 * @vitest-environment jsdom
 *
 * The real Terminal under the memoised stack (#364), with xterm and the pty
 * bridge replaced.
 *
 * The stack skips a render when only `lastActivityAt` changed. That is safe
 * only while Terminal never reads it, on any path: rendering, spawning,
 * exiting, restarting. The task is handed in as a Proxy that records every
 * field read, and those paths are walked.
 *
 * And a field Terminal reads later than its render -- the title, when Start
 * a Fresh Session names the new session -- still arrives through the stack.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../types';

const h = vi.hoisted(() => ({
  spawns: [] as { args: string[]; cwd: string; onExit: (code: number | null) => void }[],
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    textarea = document.createElement('textarea');
    attachCustomKeyEventHandler() {}
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    refresh() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('../lib/pty', () => ({
  spawnPty: async (
    opts: { args: string[]; cwd: string },
    handlers: { onExit: (code: number | null) => void },
  ) => {
    h.spawns.push({ args: opts.args, cwd: opts.cwd, onExit: handlers.onExit });
    return { id: `pty-${h.spawns.length}`, detach: () => {} };
  },
  writePty: async () => {},
  resizePty: async () => {},
  killPty: async () => {},
}));
vi.mock('../capture/hookEvents', () => ({
  startHookEvents: async () => {
    throw new Error('no hooks in tests');
  },
  resetTaskEvents: async () => {},
  endTaskEvents: async () => {},
  hookSettingsArg: () => '{}',
  onSessionStart: () => () => {},
}));
vi.mock('../capture/workspaceTrust', () => ({
  folderTrusted: async () => true,
  setTrustWaiting: () => {},
  isTrustWaiting: () => false,
  onTrustWaiting: () => () => {},
}));
vi.mock('../capture/previewGate', () => ({ endTaskPreviews: async () => {} }));
vi.mock('../capture/sessionLink', () => ({
  linkTaskSession: async () => {},
  lastModelOf: async () => null,
  newSessionId: () => 'new-session',
  sessionTranscriptExists: async () => true,
}));
vi.mock('../capture/inbox', () => ({ mcpServerPath: async () => null }));
vi.mock('./taskModel', () => ({ getTaskModel: () => null }));

const { default: TerminalStack } = await import('./TerminalStack');

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: 'Fix the login retry',
    projectId: 1,
    repoPath: '/code/x',
    baseBranch: 'main',
    branch: 'feature-1',
    worktreePath: '/code/x-1',
    sessionId: null,
    ownsWorktree: true,
    createdBranch: true,
    kind: 'work',
    status: 'idle',
    createdAt: 0,
    lastActivityAt: 5,
    seenAt: null,
    summary: null,
    reviewUrl: null,
    apiError: null,
    apiErrorText: null,
    spunFromTaskId: null,
    ...over,
  };
}

/** The task, recording each field read into `reads`. */
function watched(t: Task, reads: Set<string>): Task {
  return new Proxy(t, {
    get(target, key, receiver) {
      if (typeof key === 'string') reads.add(key);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}

// Stable, as App's are: a new callback per render would redraw every slot
// and hide a field the comparator misses.
const initialPromptFor = () => null;
const spawnArgsFor = () => undefined;
const sessionNameFor = (t: Task) => (t.sessionId === null ? t.title : undefined);
const forgetResume = () => {};
const stack = (tasks: Task[]) => (
  <TerminalStack
    tasks={tasks}
    selectedId={1}
    initialPromptFor={initialPromptFor}
    spawnArgsFor={spawnArgsFor}
    sessionNameFor={sessionNameFor}
    forgetResume={forgetResume}
  />
);

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  h.spawns = [];
});
afterEach(cleanup);

describe('Terminal under the memoised stack (#364)', () => {
  it('never reads lastActivityAt: not to render, spawn, exit or restart', async () => {
    const reads = new Set<string>();
    const { rerender } = render(stack([watched(task(), reads)]));
    await flush();
    expect(h.spawns).toHaveLength(1);

    // Capture adopts the session; the terminal re-renders with it.
    rerender(stack([watched(task({ sessionId: 's-1' }), reads)]));
    await flush();

    act(() => h.spawns[0]!.onExit(0));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Start a Fresh Session' }));
    await flush();
    expect(h.spawns).toHaveLength(2);

    // It read the task (the proof the Proxy watched something) …
    for (const k of ['id', 'title', 'sessionId', 'worktreePath', 'kind', 'reviewUrl']) expect(reads).toContain(k);
    // … and never the field the stack ignores.
    expect(reads).not.toContain('lastActivityAt');
  });

  it('a rename after mount names the fresh session; a burst in between changes nothing', async () => {
    const { rerender } = render(stack([task({ sessionId: 's-1' })]));
    await flush();
    expect(h.spawns).toHaveLength(1);

    rerender(stack([task({ sessionId: 's-1', lastActivityAt: 99 })]));
    rerender(stack([task({ sessionId: 's-1', lastActivityAt: 99, title: 'Retry the login, with backoff' })]));
    rerender(stack([task({ sessionId: 's-1', lastActivityAt: 120, title: 'Retry the login, with backoff' })]));
    await flush();

    act(() => h.spawns[0]!.onExit(0));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Start a Fresh Session' }));
    await flush();
    expect(h.spawns).toHaveLength(2);
    const args = h.spawns[1]!.args;
    expect(args[args.indexOf('--name') + 1]).toBe('Retry the login, with backoff');
  });

  it('a session adopted after mount is what a restart resumes', async () => {
    const { rerender } = render(stack([task()]));
    await flush();
    rerender(stack([task({ sessionId: 's-adopted' })]));
    await flush();
    act(() => h.spawns[0]!.onExit(1));
    await flush();
    // Not fresh: the composer's start path resumes the live session id.
    const { startPty } = await import('./Terminal');
    act(() => void startPty(1));
    await flush();
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1]!.args.join(' ')).toContain('s-adopted');
  });
});
