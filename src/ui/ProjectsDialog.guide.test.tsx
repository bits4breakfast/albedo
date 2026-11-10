/**
 * @vitest-environment jsdom
 *
 * The Projects dialog's Review Guide defaults (#295): the two lists, Albedo's
 * starting set until the project saves its own, Save storing what was typed,
 * and Use Albedo's Defaults.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const { updateProject } = await import('../db/projects');
const { runDetailsCommand } = await import('../gh/ciDetailsRun');
const { __resetQueuedCi } = await import('./transcript/ciFailure');
const { DEFAULT_CAREFUL, DEFAULT_SET_ASIDE } = await import('../guide/focus');

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
  vi.mocked(updateProject).mockClear();
  vi.mocked(runDetailsCommand).mockReset();
});
afterEach(cleanup);

async function edit() {
  render(<ProjectsDialog open onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
}
const aside = () => screen.getByLabelText(/Review Guide: Set Aside/) as HTMLTextAreaElement;
const careful = () => screen.getByLabelText(/Review Guide: Review Carefully/) as HTMLTextAreaElement;
const reset = () => screen.getByRole('button', { name: 'Use Albedo’s Defaults' }) as HTMLButtonElement;

describe('Review Guide defaults in the Projects dialog (#295)', () => {
  it('shows Albedo’s starting set for a project with none of its own', async () => {
    await edit();
    expect(aside().value).toBe(DEFAULT_SET_ASIDE.join('\n'));
    expect(careful().value).toBe(DEFAULT_CAREFUL.join('\n'));
    expect(reset().disabled).toBe(true);
    expect(screen.getByText('These are Albedo’s defaults.')).toBeTruthy();
  });

  it('saves the lists as typed, cleaned, and resets to Albedo’s', async () => {
    db.project = { ...SAVED, guideCareful: ['src/session/**'] };
    await edit();
    expect(careful().value).toBe('src/session/**');
    expect(reset().disabled).toBe(false);
    fireEvent.change(aside(), { target: { value: ' *.css \n\n# tests\n**/*.test.*' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateProject).toHaveBeenCalled());
    expect(vi.mocked(updateProject).mock.calls[0]![1]).toMatchObject({ guideSetAside: ['*.css', '**/*.test.*'], guideCareful: ['src/session/**'] });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(reset());
    expect(careful().value).toBe(DEFAULT_CAREFUL.join('\n'));
    expect(aside().value).toBe(DEFAULT_SET_ASIDE.join('\n'));
  });
});
