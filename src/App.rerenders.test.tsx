/**
 * @vitest-environment jsdom
 *
 * What a capture burst re-renders in the real shell (#364). App.tsx rendered
 * whole, as App.projectView.test.tsx does, with several tasks open: a new
 * transcript row on one task bumps its `lastActivityAt`, which hands App a
 * new tasks array. Before #364 that re-rendered every open terminal and every
 * task row; now only the row whose task changed draws again, and no terminal
 * does. Anything a terminal or a row shows still reaches it.
 */

import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { Project, Task } from './types';

const h = vi.hoisted(() => ({
  tasks: [] as Task[],
  listeners: new Set<() => void>(),
  projects: [] as Project[],
  /** Every render of a task terminal, by task id, with the props it got. */
  terminalRenders: [] as { id: number; active: boolean; title: string }[],
  /** Every render of a task row's Remote mark, by task id: one per render of an unselected row. */
  rowRenders: [] as number[],
  /** Every render of a row's context hairline: one per row render, the selected row's too. */
  meterRenders: 0,
}));

vi.mock('./ui/useTasks', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (cb: () => void) => {
    h.listeners.add(cb);
    return () => void h.listeners.delete(cb);
  };
  const useTasks = () => {
    const tasks = useSyncExternalStore(subscribe, () => h.tasks);
    return {
      tasks,
      signals: new Map(),
      loading: false,
      loadError: null,
      captureError: null,
      projects: h.projects,
      contextBySession: new Map(),
      refresh: async () => {},
      upsertTask: () => {},
      archive: async () => {},
      setDone: async () => {},
      rename: async () => true,
      markSeen: () => {},
    };
  };
  return { default: useTasks, useTasks };
});

vi.mock('./ui/Terminal', () => ({
  default: ({ task, active }: { task: Task; active?: boolean }) => {
    h.terminalRenders.push({ id: task.id, active: active === true, title: task.title });
    return <div data-testid={`pty-${task.id}`} data-title={task.title} hidden={!active} />;
  },
  focusPty: () => false,
  hasLivePty: () => false,
  usePtyLiveSince: () => null,
  ptyLiveSince: () => null,
  onPtyPresenceChange: () => () => {},
  submitPty: async () => false,
  notePty: async () => false,
  startPty: () => false,
  canResume: () => false,
  cssVar: (_n: string, f: string) => f,
  terminalTheme: () => ({}),
}));
vi.mock('./ui/RemoteMark', async (orig) => ({
  ...(await orig<typeof import('./ui/RemoteMark')>()),
  default: ({ task, variant }: { task: Task; variant: 'row' | 'bar' }) => {
    if (variant === 'row') h.rowRenders.push(task.id);
    return null;
  },
}));
vi.mock('./ui/StatusDot', async (orig) => ({
  ...(await orig<typeof import('./ui/StatusDot')>()),
  ContextMeter: () => {
    h.meterRenders += 1;
    return null;
  },
}));
vi.mock('./ui/ShellTerminal', () => ({ default: () => null }));
vi.mock('./ui/transcript/TranscriptPane', () => ({ default: () => <div data-testid="transcript" /> }));
vi.mock('./ui/editor/EditorTabs', () => ({ default: () => null, forgetEditorTabs: () => {} }));
vi.mock('./ui/Subagents', () => ({ default: () => null }));
vi.mock('./ui/StatusBar', () => ({ default: () => null }));
vi.mock('./ui/TouchedFiles', async (orig) => ({
  ...(await orig<typeof import('./ui/TouchedFiles')>()),
  default: () => null,
}));
vi.mock('./git/branchSync', async (orig) => ({
  ...(await orig<typeof import('./git/branchSync')>()),
  checkedOutBranch: async () => 'main',
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => {
    throw new Error('no Tauri in tests');
  },
  Channel: class {},
  convertFileSrc: (p: string) => p,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async () => () => {},
    isFocused: async () => true,
    requestUserAttention: async () => {},
    onCloseRequested: async () => () => {},
    listen: async () => () => {},
  }),
}));
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: async () => {
      throw new Error('no database in tests');
    },
  },
}));

const { setGitRunner } = await import('./git/worktree');
const { KEYS } = await import('./ui/persisted');
const { default: App } = await import('./App');

const N = 8;

function task(id: number): Task {
  return {
    id,
    title: `Task ${id}`,
    projectId: 1,
    repoPath: '/code/x',
    baseBranch: 'main',
    branch: `feature-${id}`,
    worktreePath: `/code/x-${id}`,
    sessionId: `s-${id}`,
    ownsWorktree: true,
    createdBranch: true,
    kind: 'work',
    status: 'idle',
    createdAt: 0,
    lastActivityAt: 1_000 + id,
    seenAt: 0,
    summary: null,
    reviewUrl: null,
    apiError: null,
    apiErrorText: null,
    spunFromTaskId: null,
  };
}

/** What useTasks does on a capture burst: one task replaced, the array new. */
function patch(id: number, p: Partial<Task>) {
  act(() => {
    h.tasks = h.tasks.map((t) => (t.id === id ? { ...t, ...p } : t));
    for (const l of [...h.listeners]) l();
  });
}

let store: Map<string, string>;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= function () {};

beforeEach(() => {
  store = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  h.projects = [
    {
      id: 1,
      name: 'acme-api',
      repoPath: '/code/x',
      worktreeRoot: '/code/x-worktrees',
      defaultBaseBranch: null,
      taskPromptTemplate: null,
      createdAt: 0,
      archivedAt: null,
    } as Project,
  ];
  h.tasks = Array.from({ length: N }, (_, i) => task(i + 1));
  h.terminalRenders = [];
  h.rowRenders = [];
  h.meterRenders = 0;
  store.set(KEYS.activeProject, 'p1');
  setGitRunner(async () => ({ code: 1, stdout: '', stderr: 'not in tests' }));
});

afterEach(cleanup);

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** App with every task's terminal open (each selected once), task 1 selected last. */
async function openAll(onRender?: (duration: number) => void) {
  render(
    <Profiler id="app" onRender={(_id, _phase, duration) => onRender?.(duration)}>
      <App />
    </Profiler>,
  );
  await settle();
  for (const t of [...h.tasks].reverse()) {
    fireEvent.click(document.querySelector(`[data-task-id="${t.id}"]`)!);
    await settle();
  }
  for (const t of h.tasks) expect(screen.getByTestId(`pty-${t.id}`)).toBeTruthy();
  h.terminalRenders = [];
  h.rowRenders = [];
  h.meterRenders = 0;
}

describe('a capture burst (#364)', () => {
  it('re-renders no terminal and only the row of the task that changed', async () => {
    await openAll();
    // Task 8 is the newest already: the burst does not move it.
    patch(8, { lastActivityAt: 9_999 });
    await settle();
    expect(h.terminalRenders).toEqual([]);
    expect(h.rowRenders).toEqual([8]);
    expect(h.meterRenders).toBe(1);
  });

  it('a burst that moves a task up redraws the rows whose ⌘ number moved, and no terminal', async () => {
    await openAll();
    patch(3, { lastActivityAt: 9_999 });
    await settle();
    expect(h.terminalRenders).toEqual([]);
    // 3 moved to the top; 8..4 each moved one place down. 2 and 1 stayed.
    expect([...h.rowRenders].sort()).toEqual([3, 4, 5, 6, 7, 8]);
    const shortcuts = [...document.querySelectorAll('[data-task-id]')].map(
      (row) => `${row.getAttribute('data-task-id')}:${row.querySelector('.task-index')?.textContent ?? ''}`,
    );
    expect(shortcuts).toEqual(['3:⌘1', '8:⌘2', '7:⌘3', '6:⌘4', '5:⌘5', '4:⌘6', '2:⌘7', '1:⌘8']);
  });

  it('a field a terminal reads still reaches it, on that terminal only', async () => {
    await openAll();
    patch(3, { title: 'Renamed' });
    await settle();
    expect(h.terminalRenders).toEqual([{ id: 3, active: false, title: 'Renamed' }]);
    expect(screen.getByTestId('pty-3').getAttribute('data-title')).toBe('Renamed');
  });

  it('selecting another task re-renders the two terminals whose `active` changed', async () => {
    await openAll();
    fireEvent.click(document.querySelector('[data-task-id="4"]')!);
    await settle();
    const ids = [...new Set(h.terminalRenders.map((r) => r.id))].sort();
    expect(ids).toEqual([1, 4]);
    expect(screen.getByTestId('pty-4').hidden).toBe(false);
    expect(screen.getByTestId('pty-1').hidden).toBe(true);
  });

  it('a splitter drag renders nothing per move: the pane is resized, and the ratio committed on release', async () => {
    let commits = 0;
    let counting = false;
    await openAll(() => {
      if (counting) commits += 1;
    });
    const panes = document.querySelector<HTMLElement>('.panes')!;
    panes.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const pty = document.querySelector<HTMLElement>('.pane-pty')!;
    expect(pty.style.flex).toBe('0 0 55.00%');

    fireEvent.pointerDown(document.querySelector('.panes > .splitter')!);
    await settle();
    counting = true;
    for (const x of [500, 520, 610, 640]) {
      act(() => void window.dispatchEvent(new MouseEvent('pointermove', { clientX: x })));
      expect(pty.style.flex).toBe(`0 0 ${((x / 1000) * 100).toFixed(2)}%`);
    }
    counting = false;
    expect(commits).toBe(0);
    expect(store.get(KEYS.splitRatio)).toBe('0.550');

    act(() => void window.dispatchEvent(new MouseEvent('pointerup')));
    await settle();
    expect(pty.style.flex).toBe('0 0 64.00%');
    expect(store.get(KEYS.splitRatio)).toBe('0.640');
    expect(h.terminalRenders).toEqual([]);
  });

  it('measured: 50 bursts on one running task, then 50 across three', async () => {
    let total = 0;
    let counting = false;
    await openAll((d) => {
      if (counting) total += d;
    });
    const run = (label: string, ids: number[]) => {
      h.terminalRenders = [];
      h.meterRenders = 0;
      total = 0;
      counting = true;
      for (let i = 0; i < 50; i++) patch(ids[i % ids.length]!, { lastActivityAt: (h.tasks.at(-1)?.lastActivityAt ?? 0) + 10_000 + i });
      counting = false;
      // Not asserted beyond sanity: printed for the PR's before/after numbers.
      process.stdout.write(
        `[#364] ${label}, ${N} open tasks: ${h.terminalRenders.length} terminal renders, ${h.meterRenders} row renders, ${total.toFixed(1)} ms in commits\n`,
      );
    };
    run('50 bursts on 1 task', [8]);
    run('50 bursts across 3 tasks', [6, 7, 8]);
    expect(h.tasks).toHaveLength(N);
  }, 30_000);
});
