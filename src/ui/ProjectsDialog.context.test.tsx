/**
 * @vitest-environment jsdom
 *
 * The Review Guide's Context in Projects… (#444 review): beside the guide's
 * defaults, what it is set to, and Edit… for the same sheet the guide opens,
 * which saves on its own. Escape closes the sheet, not the dialog.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Project, Task } from '../types';

const db = vi.hoisted(() => ({ project: null as unknown as Project, tasks: [] as Partial<Task>[] }));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/Users/x' }));
vi.mock('../db/projects', () => ({
  ProjectExistsError: class extends Error {},
  archiveProject: vi.fn(),
  createProject: vi.fn(),
  listProjects: vi.fn(async () => [db.project]),
  getProject: vi.fn(async () => db.project),
  updateProject: vi.fn(async (_id: number, patch: Partial<Project>) => {
    db.project = { ...db.project, ...patch };
  }),
}));
vi.mock('../db', () => ({ listTasks: vi.fn(async () => db.tasks) }));
vi.mock('../git/reconcile', () => ({
  checkWorktreeRoot: vi.fn(async (root: string) => ({ ok: true, path: root })),
  expandTilde: (p: string) => p,
  validateWorktreeRoot: (root: string) => ({ ok: true, path: root }),
}));
vi.mock('../git/worktree', () => ({
  basename: (p: string) => p.split('/').pop(),
  defaultWorktreeRoot: (n: string) => `~/agents/${n}`,
  listBranches: vi.fn(async () => ({ all: ['main'] })),
  repoRootFor: vi.fn(),
}));
vi.mock('../gh/ciDetailsRun', () => ({ runDetailsCommand: vi.fn() }));

const { ProjectsDialog } = await import('./ProjectsDialog');
const { runDetailsCommand } = await import('../gh/ciDetailsRun');
const { __resetQueuedCi } = await import('./transcript/ciFailure');
const { setContextFiles, resetContextSettingsForTests } = await import('../guide/context');

const SAVED: Project = {
  id: 3,
  name: 'recipe-app',
  repoPath: '/repo/recipe-app',
  worktreeRoot: '/wt/recipe-app',
  defaultBaseBranch: null,
  taskPromptTemplate: null,
  ciDetails: 'link',
  ciDetailsCommand: null,
  guideSetAside: null,
  guideCareful: null,
  createdAt: 0,
  archivedAt: null,
};

let disk: Map<number, string>;
let prevFiles: ReturnType<typeof setContextFiles>;

beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  db.project = { ...SAVED };
  db.tasks = [];
  __resetQueuedCi();
  vi.mocked(runDetailsCommand).mockReset();
  disk = new Map();
  resetContextSettingsForTests();
  prevFiles = setContextFiles({ read: async (id) => disk.get(id) ?? null, write: async (id, json) => void disk.set(id, json) });
});
afterEach(() => {
  cleanup();
  setContextFiles(prevFiles);
});

async function edit() {
  render(<ProjectsDialog open onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
}

describe('Review Guide Context in the Projects dialog (#444)', () => {
  it('says it is off, and Edit… opens the sheet, which saves on its own', async () => {
    await edit();
    expect(await screen.findByText('Off')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Review Guide Context' }));
    const sheet = await screen.findByRole('dialog', { name: 'Review Guide Context · recipe-app' });
    fireEvent.change(within(sheet).getByLabelText('Also look up'), { target: { value: 'Find the ticket.' } });
    fireEvent.change(within(sheet).getByLabelText('Tools it may use'), { target: { value: 'mcp__tracker__get_issue' } });
    // No task here: nothing to try it on.
    expect((within(sheet).getByRole('button', { name: 'Try on the selected task' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Review Guide Context/ })).toBeNull());
    expect(JSON.parse(disk.get(3)!)).toMatchObject({ instructions: 'Find the ticket.', tools: ['mcp__tracker__get_issue'] });
    expect(screen.getByText('On · 1 tool · Claude Sonnet · 2 min')).toBeTruthy();
  });

  it('Escape closes the sheet and leaves the project being edited', async () => {
    await edit();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Review Guide Context' }));
    await screen.findByRole('dialog', { name: /Review Guide Context/ });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /Review Guide Context/ })).toBeNull();
    expect(screen.getByText('Review Guide: Context')).toBeTruthy();
  });
});
