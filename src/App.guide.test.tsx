/**
 * @vitest-environment jsdom
 *
 * The Review Guide's way in, in the real shell (#186): App.tsx rendered whole
 * (harness as in App.projectView.test.tsx), its tab and the task's ⋯ menu
 * opening it (the Files pane's button is gone, #335). The pane itself is
 * GuidePane.test.tsx's.
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
    upsertTask: (t: Task) => {
      h.tasks = [...h.tasks.filter((x) => x.id !== t.id), t];
    },
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
vi.mock('./guide/GuidePane', async () => {
  const { useOpenFile } = await import('./ui/editor/openFile');
  return {
    default: function GuidePane({ task }: { task: Task }) {
      const openFile = useOpenFile();
      return (
        <>
          <div data-testid="guide">{`guide for ${task.id}`}</div>
          <button type="button" onClick={() => openFile({ path: 'src/a.ts' })}>
            Open a.ts
          </button>
        </>
      );
    },
  };
});
vi.mock('./ui/StatusBar', () => ({ default: () => null }));
// Checking a PR out for review (#329): no git, the task it would make.
vi.mock('./ui/openReview', async (orig) => ({
  ...(await orig<typeof import('./ui/openReview')>()),
  openReviewTask: async (_p: unknown, pr: { url: string; title: string }) => ({
    ...task(99, 1, pr.title),
    branch: 'review/7',
    reviewUrl: pr.url,
  }),
}));
vi.mock('./ui/TouchedFiles', async (orig) => ({
  ...(await orig<typeof import('./ui/TouchedFiles')>()),
  default: () => <div data-testid="files" />,
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
const reviewStore = await import('./gh/reviewStore');

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
});

describe('the reading tab, per task (#314)', () => {
  const tabSelected = (name: string) => screen.getByRole('tab', { name }).getAttribute('aria-selected');
  const row = (title: string) => screen.getByRole('option', { name: new RegExp(title) });

  it('each task comes back on the tab it was left on', async () => {
    h.tasks = [task(10, 1, 'Fix the login retry'), task(11, 1, 'Speed up the build')];
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    render(<App />);
    await settle();

    fireEvent.click(screen.getByRole('tab', { name: 'Guide' }));
    await settle();
    expect(tabSelected('Guide')).toBe('true');

    // A task not looked at yet opens on Transcript, not on the Guide just chosen.
    fireEvent.click(row('Speed up the build'));
    await settle();
    expect(tabSelected('Transcript')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    await settle();

    fireEvent.click(row('Fix the login retry'));
    await settle();
    expect(tabSelected('Guide')).toBe('true');

    fireEvent.click(row('Speed up the build'));
    await settle();
    expect(tabSelected('Files')).toBe('true');

    // Kept across a restart.
    expect(JSON.parse(store.get(KEYS.taskTabs)!)).toEqual([
      [10, 'guide'],
      [11, 'files'],
    ]);
  });

  it('closing a file opened from the Guide goes back to the Guide, not to Transcript (#322)', async () => {
    h.tasks = [task(10, 1, 'Fix the login retry')];
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    render(<App />);
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Guide' }));
    await settle();
    fireEvent.click(await screen.findByRole('button', { name: 'Open a.ts' }));
    await settle();
    expect(tabSelected('Editor')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }));
    await settle();
    expect(tabSelected('Guide')).toBe('true');
    // From Files, the same: back to Files.
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Guide' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Open a.ts' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }));
    await settle();
    expect(tabSelected('Guide')).toBe('true');
  });

  it('a PR opened from Reviewing lands on its Guide (#329)', async () => {
    reviewStore.setReviewFetcherForTests(async () => ({
      viewer: 'me',
      prs: [
        {
          url: 'https://github.com/acme/api/pull/7', number: 7, title: 'Retry webhook delivery', isDraft: false, author: 'alice',
          additions: 1, deletions: 1, headOid: 'h1', baseBranch: 'main', commitCount: 1, lastCommitAt: 0, createdAt: 0, updatedAt: 0,
          requestedAt: 0, teams: [], talk: [], forcePushedAt: null, yourReview: null, approved: false, section: 'requested',
        },
      ],
    }));
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    render(<App />);
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: /Reviewing/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Retry webhook delivery/ }));
    await settle();
    await settle();
    expect(tabSelected('Guide')).toBe('true');
    expect(screen.getByTestId('guide').textContent).toBe('guide for 99');
  });

  it('a guide asked for another task lands on that task, not on the one on screen', async () => {
    h.tasks = [task(10, 1, 'Fix the login retry'), task(11, 1, 'Speed up the build')];
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    render(<App />);
    await settle();
    act(() => void requestGuide(11));
    await settle();
    expect(tabSelected('Transcript')).toBe('true');
    fireEvent.click(row('Speed up the build'));
    await settle();
    expect(tabSelected('Guide')).toBe('true');
  });
});

describe('the task’s two ⋯ menus (#331)', () => {
  const row = (title: string) => screen.getByRole('option', { name: new RegExp(title) });
  /** What a menu offers: each item's label, shortcut, greyed or not, tooltip, and where a group starts. */
  const offered = () =>
    [...screen.getByRole('menu').querySelectorAll('[role=menuitem]')].map((b) => ({
      label: b.querySelector('.row-menu-label')?.textContent,
      aside: b.querySelector('.row-menu-aside')?.textContent ?? null,
      disabled: (b as HTMLButtonElement).disabled,
      group: b.getAttribute('data-group') === 'true',
      title: b.getAttribute('title'),
    }));
  const barMenu = () =>
    fireEvent.click(within(document.querySelector<HTMLElement>('.main-bar')!).getByRole('button', { name: /^Actions for / }));
  const rowMenu = (title: string) => fireEvent.contextMenu(row(title));

  it.each([
    ['a task on a branch', task(10, 1, 'Fix the login retry')],
    ['a chat', { ...task(10, 1, 'Fix the login retry'), kind: 'chat' as const, branch: '', worktreePath: '/code/x' }],
    ['a task marked done', { ...task(10, 1, 'Fix the login retry'), status: 'done' as const }],
  ])('offer the same items, in the same order, for %s', async (_, t) => {
    h.tasks = [t];
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    render(<App />);
    await settle();

    barMenu();
    const fromBar = offered();
    expect(screen.getByRole('menu').querySelector('.row-menu-head')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('menu')).toBeNull();

    rowMenu('Fix the login retry');
    const fromRow = offered();
    // The row's menu says which task was right-clicked; the bar's sits beside the name.
    expect(screen.getByRole('menu').querySelector('.row-menu-head')?.textContent).toBe('Fix the login retry');
    expect(fromRow).toEqual(fromBar);
    expect(fromRow.length).toBeGreaterThan(5);
  });

  it('Review Guide from another task’s row selects that task and shows its Guide', async () => {
    h.tasks = [task(10, 1, 'Fix the login retry'), task(11, 1, 'Speed up the build')];
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    render(<App />);
    await settle();
    expect(row('Speed up the build').getAttribute('aria-selected')).toBe('false');

    rowMenu('Speed up the build');
    fireEvent.click(screen.getByRole('menuitem', { name: /Review Guide/ }));
    await settle();
    expect(row('Speed up the build').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Guide' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('guide').textContent).toBe('guide for 11');
  });

  it('another item from a row acts on that row’s task and leaves the selection alone', async () => {
    h.tasks = [task(10, 1, 'Fix the login retry'), task(11, 1, 'Speed up the build')];
    store.set(KEYS.activeProject, 'p1');
    store.set(KEYS.selectedTask, '10');
    render(<App />);
    await settle();

    rowMenu('Speed up the build');
    fireEvent.click(screen.getByRole('menuitem', { name: /Remind Me/ }));
    await settle();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Speed up the build')).toBeTruthy();
    expect(row('Fix the login retry').getAttribute('aria-selected')).toBe('true');
  });
});
