/**
 * @vitest-environment jsdom
 *
 * The terminal holds the start gate (#439, startGate.ts): from the spawn of
 * a pty with the hooks until a SessionStart of that process, or until the
 * pty ends. With xterm and the pty bridge replaced, and the hook channel's
 * SessionStart driven by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Task } from '../types';

type SessionListener = (taskId: number, sessionId: string, source: string, at: number) => void;

const h = vi.hoisted(() => ({
  spawns: [] as { onExit: (code: number | null) => void }[],
  sessionListeners: new Set<SessionListener>(),
  hooks: true,
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
  spawnPty: async (_opts: unknown, handlers: { onExit: (code: number | null) => void }) => {
    h.spawns.push({ onExit: handlers.onExit });
    return { id: `pty-${h.spawns.length}`, detach: () => {} };
  },
  writePty: async () => {},
  resizePty: async () => {},
  killPty: async () => {},
}));
vi.mock('../capture/hookEvents', () => ({
  startHookEvents: async () => {
    if (!h.hooks) throw new Error('no hooks');
    return '/tmp/hook.sh';
  },
  resetTaskEvents: async () => {},
  endTaskEvents: async () => {},
  hookSettingsArg: () => '{}',
  onSessionStart: (cb: SessionListener) => {
    h.sessionListeners.add(cb);
    return () => h.sessionListeners.delete(cb);
  },
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
  newSessionId: () => '11111111-1111-4111-8111-111111111111',
  sessionTranscriptExists: async () => true,
}));
vi.mock('../capture/inbox', () => ({ mcpServerPath: async () => null }));
vi.mock('./taskModel', () => ({ getTaskModel: () => null }));

const { default: TerminalStack } = await import('./TerminalStack');
const { hasLivePty, onPtyPresenceChange, startPty } = await import('./Terminal');
const { __resetStartGate, awaitingStart } = await import('./transcript/startGate');

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const SID = '11111111-1111-4111-8111-111111111111';

function task(): Task {
  return {
    id: 1,
    title: 'Tidy the settings page',
    projectId: 1,
    repoPath: '/code/x',
    baseBranch: 'main',
    branch: 'feature-1',
    worktreePath: '/code/x-1',
    sessionId: SID,
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
  };
}

const none = () => null;
const noArgs = () => undefined;
const noName = () => undefined;
const forget = () => {};
const stack = () => (
  <TerminalStack
    tasks={[task()]}
    selectedId={1}
    initialPromptFor={none}
    spawnArgsFor={noArgs}
    sessionNameFor={noName}
    forgetResume={forget}
  />
);

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** A SessionStart as the hook stamps it: whole seconds. */
function sessionStart(at: number, source = 'resume') {
  act(() => {
    for (const cb of [...h.sessionListeners]) cb(1, SID, source, Math.floor(at / 1000) * 1000);
  });
}

beforeEach(() => {
  h.spawns = [];
  h.hooks = true;
});
afterEach(() => {
  cleanup();
  __resetStartGate();
});

describe('the start gate, per pty process (#439)', () => {
  it('shut from the spawn, before the pty is announced, until this process reports its start', async () => {
    const atAnnounce: boolean[] = [];
    const off = onPtyPresenceChange((id, live) => {
      if (id === 1 && live) atAnnounce.push(awaitingStart(1));
    });
    render(stack());
    await flush();
    off();
    expect(h.spawns).toHaveLength(1);
    expect(hasLivePty(1)).toBe(true);
    // A send waiting on the announcement must already find it shut.
    expect(atAnnounce).toEqual([true]);
    expect(awaitingStart(1)).toBe(true);

    sessionStart(Date.now());
    expect(awaitingStart(1)).toBe(false);
  });

  it('a SessionStart from an earlier process opens nothing', async () => {
    render(stack());
    await flush();
    sessionStart(Date.now() - 60_000, 'startup');
    expect(awaitingStart(1)).toBe(true);
  });

  it('a later SessionStart of the same process (/clear) leaves it open', async () => {
    render(stack());
    await flush();
    sessionStart(Date.now());
    sessionStart(Date.now(), 'clear');
    expect(awaitingStart(1)).toBe(false);
  });

  it('ends with the pty, after it is gone, and a respawn waits for its own start', async () => {
    render(stack());
    await flush();
    sessionStart(Date.now());
    expect(awaitingStart(1)).toBe(false);

    act(() => h.spawns[0]!.onExit(0));
    await flush();
    expect(awaitingStart(1)).toBe(false);

    // The first process's SessionStart was seen; the new one has not started.
    act(() => void startPty(1));
    await flush();
    expect(h.spawns).toHaveLength(2);
    expect(awaitingStart(1)).toBe(true);
  });

  it('clears when the pty exits before it started', async () => {
    const atClear: boolean[] = [];
    render(stack());
    await flush();
    expect(awaitingStart(1)).toBe(true);
    const off = onPtyPresenceChange((id, live) => {
      if (id === 1 && !live) atClear.push(awaitingStart(1));
    });
    act(() => h.spawns[0]!.onExit(1));
    await flush();
    off();
    // Still shut when the pty's end is announced: cleared only after.
    expect(atClear).toEqual([true]);
    expect(awaitingStart(1)).toBe(false);
  });

  it('a pty spawned without the hooks never waits: no SessionStart would come', async () => {
    h.hooks = false;
    render(stack());
    await flush();
    expect(hasLivePty(1)).toBe(true);
    expect(awaitingStart(1)).toBe(false);
  });

  it('clears when the terminal goes away', async () => {
    render(stack());
    await flush();
    expect(awaitingStart(1)).toBe(true);
    cleanup();
    expect(awaitingStart(1)).toBe(false);
  });
});
