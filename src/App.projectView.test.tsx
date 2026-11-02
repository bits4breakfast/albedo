/**
 * @vitest-environment jsdom
 *
 * The project view in the real shell (#181): App.tsx rendered whole, with the
 * pieces that need Tauri (tasks from SQLite, ptys, the transcript) replaced.
 * The hooks' own rules are in ui/app/useSelection.test.tsx; this proves the
 * entry points a person uses -- the tab, the breadcrumb -- and what the pane
 * then shows: the main checkout's tree, and no composer, transcript or
 * terminal.
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
vi.mock('./ui/StatusBar', () => ({ default: () => null }));
vi.mock('./ui/TouchedFiles', async (orig) => ({
  ...(await orig<typeof import('./ui/TouchedFiles')>()),
  default: ({ task }: { task: Task }) => <div data-testid="touched-files">{task.title}</div>,
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

const bar = () => document.querySelector<HTMLElement>('.main-bar')!;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('the project view', () => {
  it('a tab with nothing selected shows the main checkout: header, tree, no composer, no terminal', async () => {
    store.set(KEYS.activeProject, 'p2');
    render(<App />);
    await settle();

    expect(within(bar()).getByText('infra')).toBeTruthy();
    expect(await within(bar()).findByText('main')).toBeTruthy();
    expect(within(bar()).getByRole('button', { name: 'New Task' })).toBeTruthy();
    // No layout switch: there is one pane.
    expect(within(bar()).queryByRole('group', { name: 'Pane layout' })).toBeNull();

    expect(await screen.findByText('README.md')).toBeTruthy();
    expect(screen.getByText('src')).toBeTruthy();
    // The tree is listed in the main checkout, not in any worktree.
    expect(gitCalls.some((c) => c.args[0] === 'ls-files' && c.cwd === '/code/infra')).toBe(true);
    expect(screen.queryByRole('tab', { name: 'Transcript' })).toBeNull();
    expect(screen.queryByTestId('transcript')).toBeNull();
    expect(h.transcriptMounts).toEqual([]);
    expect(h.terminalMounts).toEqual([]);
    expect(screen.queryByText('No task selected.')).toBeNull();
  });

  it('a file opened from the tree opens read-only, in the editor beside the tree', async () => {
    store.set(KEYS.activeProject, 'p2');
    render(<App />);
    await settle();

    fireEvent.click(await screen.findByText('README.md'));
    await settle();
    expect(screen.getByTestId('editor')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Editor' }).getAttribute('aria-selected')).toBe('true');
    const last = h.editors[h.editors.length - 1]!;
    expect(last).toEqual({ taskId: -2, path: 'README.md', readOnly: true });
    // Still no session anywhere.
    expect(h.transcriptMounts).toEqual([]);
    expect(h.terminalMounts).toEqual([]);
  });

  it('clicking the tab already showing goes from its task to the project view', async () => {
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    render(<App />);
    await settle();
    expect(within(bar()).getByText('Fix the login retry')).toBeTruthy();
    expect(screen.getByTestId('transcript')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /acme-api/ }));
    await settle();
    expect(within(bar()).queryByText('Fix the login retry')).toBeNull();
    expect(within(bar()).getByText('acme-api')).toBeTruthy();
    expect(screen.queryByTestId('transcript')).toBeNull();
    expect(await screen.findByText('README.md')).toBeTruthy();
    expect(store.get(KEYS.selectedTask)).toBeUndefined();
  });

  it('clicking the project name in the breadcrumb goes to the project view', async () => {
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    render(<App />);
    await settle();

    fireEvent.click(within(bar()).getByRole('button', { name: 'acme-api' }));
    await settle();
    expect(within(bar()).queryByText('Fix the login retry')).toBeNull();
    expect(await screen.findByText('README.md')).toBeTruthy();
  });

  it('switching to another tab and back lands where each was left', async () => {
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    render(<App />);
    await settle();

    fireEvent.click(screen.getByRole('tab', { name: /infra/ }));
    await settle();
    expect(within(bar()).getByText('infra')).toBeTruthy();
    expect(within(bar()).queryByText('Fix the login retry')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /acme-api/ }));
    await settle();
    expect(within(bar()).getByText('Fix the login retry')).toBeTruthy();
  });
});
