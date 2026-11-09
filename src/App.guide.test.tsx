/**
 * @vitest-environment jsdom
 *
 * The Review Guide's way in, in the real shell (#186): App.tsx rendered whole
 * (harness as in App.projectView.test.tsx), the task's ⋯ menu and the Files
 * pane's button opening a Guide tab in the reading pane, and its ✕ closing
 * it. The pane itself is GuidePane.test.tsx's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { Project, Task } from './types';

const requestGuideRef = vi.hoisted(() => ({ current: null as ((id: number) => void) | null }));
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
  // The Files pane's Guide button, as GitBar wires it.
  default: ({ task }: { task: Task }) => (
    <button type="button" onClick={() => requestGuideRef.current?.(task.id)}>
      Files Guide
    </button>
  ),
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
const { requestGuide } = await import('./guide/openGuide');
requestGuideRef.current = (id) => void requestGuide(id);

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

describe('opening the Review Guide', () => {
  it('the Guide tab is always there for a task on a branch, with no ✕; ⋯ › Review Guide switches to it', async () => {
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    render(<App />);
    await settle();
    const tab = screen.getByRole('tab', { name: 'Guide' });
    expect(tab.getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Close the guide' })).toBeNull();

    fireEvent.click(within(document.querySelector<HTMLElement>('.main-bar')!).getByRole('button', { name: 'Actions for Fix the login retry' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Review Guide/ }));
    await settle();
    expect(screen.getByRole('tab', { name: 'Guide' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('guide').textContent).toBe('guide for 10');

    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    await settle();
    expect(screen.getByRole('tab', { name: 'Guide' }).getAttribute('aria-selected')).toBe('false');
  });

  it('from the Files pane’s button', async () => {
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    render(<App />);
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Files Guide' }));
    await settle();
    expect(screen.getByRole('tab', { name: 'Guide' }).getAttribute('aria-selected')).toBe('true');
  });
});
