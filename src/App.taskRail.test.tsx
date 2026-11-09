/**
 * @vitest-environment jsdom
 *
 * Collapsing the task list to its rail (#266), in the real shell: App.tsx
 * rendered whole (harness as in App.guide.test.tsx). The ‹ button, the app
 * ⋯ menu's item and ⌥⌘T all switch it; the choice is remembered across a
 * restart; and the selection never moves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { Project, Task } from './types';

const h = vi.hoisted(() => ({
  tasks: [] as Task[],
  projects: [] as Project[],
  transcriptMounts: [] as (number | null)[],
  terminalMounts: [] as number[],
  editors: [] as { taskId: number; path: string | null; readOnly: boolean }[],
}));

vi.mock('./ui/useTasks', () => {
  const useTasks = () => ({
    tasks: h.tasks,
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
  });
  return { default: useTasks, useTasks };
});

// A task's pty and transcript: recorded, never run. The composer lives in the
// transcript pane, so "no transcript pane" is "no composer".
vi.mock('./ui/Terminal', () => ({
  default: ({ task }: { task: Task }) => {
    h.terminalMounts.push(task.id);
    return <div data-testid="pty" />;
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
vi.mock('./ui/ShellTerminal', () => ({ default: () => null }));
vi.mock('./ui/transcript/TranscriptPane', () => ({
  default: ({ taskId }: { taskId: number | null }) => {
    h.transcriptMounts.push(taskId);
    return <div data-testid="transcript" />;
  },
}));
vi.mock('./ui/editor/EditorTabs', () => ({
  default: (p: { task: Task; request: { path: string } | null; readOnly?: boolean }) => {
    h.editors.push({ taskId: p.task.id, path: p.request?.path ?? null, readOnly: p.readOnly === true });
    return <div data-testid="editor" />;
  },
  forgetEditorTabs: () => {},
}));
vi.mock('./ui/Subagents', () => ({ default: () => null }));
vi.mock('./guide/GuidePane', () => ({
  default: ({ task }: { task: Task }) => <div data-testid="guide">{`guide for ${task.id}`}</div>,
}));
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

function project(id: number, name: string): Project {
  return {
    id,
    name,
    repoPath: `/code/${name}`,
    worktreeRoot: `/code/${name}-worktrees`,
    defaultBaseBranch: null,
    taskPromptTemplate: null,
    createdAt: 0,
    archivedAt: null,
  } as Project;
}

function task(id: number, projectId: number, title: string): Task {
  return {
    id,
    title,
    projectId,
    repoPath: '/code/x',
    baseBranch: 'main',
    branch: `feature-${id}`,
    worktreePath: `/code/x-${id}`,
    sessionId: null,
    ownsWorktree: true,
    createdBranch: true,
    kind: 'work',
    status: 'idle',
    createdAt: 0,
    lastActivityAt: null,
    seenAt: null,
    summary: null,
    reviewUrl: null,
  };
}

let store: Map<string, string>;
const gitCalls: { args: string[]; cwd: string | undefined }[] = [];

// What jsdom lacks and the shell's layout uses.
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
  h.projects = [project(1, 'acme-api'), project(2, 'infra')];
  h.tasks = [task(10, 1, 'Fix the login retry')];
  h.transcriptMounts = [];
  h.terminalMounts = [];
  h.editors = [];
  gitCalls.length = 0;
  setGitRunner(async (args, cwd) => {
    gitCalls.push({ args, cwd });
    if (args[0] === 'ls-files') return { code: 0, stdout: 'README.md\0src/index.ts\0', stderr: '' };
    if (args[0] === 'status') return { code: 0, stdout: ' M README.md\0', stderr: '' };
    return { code: 1, stdout: '', stderr: 'not in tests' };
  });
});

afterEach(cleanup);

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}


const sidebar = () => document.querySelector<HTMLElement>('.sidebar')!;
const isRail = () => sidebar().querySelector('.task-rail') !== null;

function appMenu() {
  fireEvent.click(within(document.querySelector<HTMLElement>('.header')!).getByRole('button', { name: 'More' }));
}

describe('collapsing the task list (#266)', () => {
  beforeEach(() => {
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    h.tasks = [task(10, 1, 'Fix the login retry'), task(11, 1, 'ABC-1234 filter-by-tag')];
  });

  it('‹ collapses to the rail, › expands; remembered; the selection stays', async () => {
    render(<App />);
    await settle();
    expect(isRail()).toBe(false);
    expect(sidebar().nextElementSibling?.classList.contains('splitter-v')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Task List' }));
    await settle();
    expect(isRail()).toBe(true);
    expect(sidebar().dataset.collapsed).toBe('true');
    // The rail's own width, not the list's; nothing to drag.
    expect(sidebar().style.width).toBe('');
    expect(sidebar().nextElementSibling?.classList.contains('splitter')).toBe(false);
    expect(store.get(KEYS.taskListCollapsed)).toBe('1');
    expect(store.get(KEYS.selectedTask)).toBe('10');
    expect(document.querySelector('.main-ident-title')?.textContent).toBe('Fix the login retry');

    fireEvent.click(screen.getByRole('button', { name: 'Expand Task List' }));
    await settle();
    expect(isRail()).toBe(false);
    expect(store.get(KEYS.taskListCollapsed)).toBe('0');
    expect(store.get(KEYS.selectedTask)).toBe('10');
  });

  it('starts collapsed after a restart that left it so', async () => {
    store.set(KEYS.taskListCollapsed, '1');
    render(<App />);
    await settle();
    expect(isRail()).toBe(true);
  });

  it('from the app ⋯ menu, which names the way it goes and its key', async () => {
    render(<App />);
    await settle();
    appMenu();
    const collapse = await screen.findByRole('menuitem', { name: /Collapse Task List/ });
    expect(collapse.textContent).toContain('⌥⌘T');
    fireEvent.click(collapse);
    await settle();
    expect(isRail()).toBe(true);
    appMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Expand Task List/ }));
    await settle();
    expect(isRail()).toBe(false);
  });

  it('⌥⌘T toggles it, read from the physical key, and leaves the selection', async () => {
    render(<App />);
    await settle();
    fireEvent.keyDown(window, { key: '†', code: 'KeyT', metaKey: true, altKey: true });
    await settle();
    expect(isRail()).toBe(true);
    expect(store.get(KEYS.selectedTask)).toBe('10');
    fireEvent.keyDown(window, { key: '†', code: 'KeyT', metaKey: true, altKey: true });
    await settle();
    expect(isRail()).toBe(false);
    expect(store.get(KEYS.selectedTask)).toBe('10');
  });

  it('a circle’s popover selects a task in the pane', async () => {
    store.set(KEYS.taskListCollapsed, '1');
    render(<App />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Idle, 2 tasks' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Idle' })).getByText('filter-by-tag'));
    await settle();
    expect(store.get(KEYS.selectedTask)).toBe('11');
    expect(screen.queryByRole('menu', { name: 'Idle' })).toBeNull();
  });
});
