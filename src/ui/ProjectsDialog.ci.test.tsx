/**
 * @vitest-environment jsdom
 *
 * The Projects dialog's CI Details field (#280, step 2): three choices under
 * Initial Prompt, the command and its contract only for "A Command", Save
 * storing the choice, and "Test on the Last Failure" running the SAVED
 * command -- read back from the project row -- and showing what it gave.
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
const { __resetQueuedCi, observeCiQueue } = await import('./transcript/ciFailure');
const { parsePrView } = await import('../gh/prStatus');

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
  return screen.getByRole('radiogroup', { name: /CI Details/ });
}

describe('CI Details in the Projects dialog', () => {
  it('offers three choices, name and link only chosen by default, and no command field', async () => {
    await edit();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')?.querySelector('.wt-option-label')?.textContent)).toEqual([
      'Name and Link Only',
      'GitHub Actions',
      'A Command',
    ]);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('textbox', { name: 'The command' })).toBeNull();
  });

  it('shows the command, its contract, and a test that waits for Save', async () => {
    await edit();
    fireEvent.click(screen.getByRole('radio', { name: /A Command/ }));
    const input = screen.getByRole('textbox', { name: 'The command' });
    expect(screen.getByText(/Gets the failing checks as JSON on stdin/)).toBeTruthy();
    fireEvent.change(input, { target: { value: './scripts/ci-details.sh' } });
    const test = screen.getByRole('button', { name: 'Test on the Last Failure' }) as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    expect(screen.getByText('Save first: the test runs the saved command.')).toBeTruthy();
  });

  it('saves the choice and the command', async () => {
    await edit();
    fireEvent.click(screen.getByRole('radio', { name: /A Command/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'The command' }), { target: { value: '  ./scripts/ci-details.sh ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateProject).toHaveBeenCalled());
    expect(vi.mocked(updateProject).mock.calls[0]![1]).toMatchObject({ ciDetails: 'command', ciDetailsCommand: './scripts/ci-details.sh' });
  });

  it('refuses "A Command" with no command', async () => {
    await edit();
    fireEvent.click(screen.getByRole('radio', { name: /A Command/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Give the command CI Details runs, or choose another option.')).toBeTruthy();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('keeps a typed command while another choice is made', async () => {
    await edit();
    fireEvent.click(screen.getByRole('radio', { name: /A Command/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'The command' }), { target: { value: './x.sh' } });
    fireEvent.click(screen.getByRole('radio', { name: /GitHub Actions/ }));
    fireEvent.click(screen.getByRole('radio', { name: /A Command/ }));
    expect((screen.getByRole('textbox', { name: 'The command' }) as HTMLInputElement).value).toBe('./x.sh');
  });

  it('runs the saved command, from the project row, on the last queued failure, and shows what it gave', async () => {
    db.project = { ...SAVED, ciDetails: 'command', ciDetailsCommand: './scripts/ci-details.sh' };
    db.tasks = [{ id: 7, title: 'Fix fractions', projectId: 3, worktreePath: '/wt/recipe-app/fix', repoPath: '/repo/recipe-app', kind: 'work', status: 'idle' }];
    const pr = parsePrView(
      JSON.stringify({
        number: 14,
        state: 'OPEN',
        headRefName: 'fix',
        headRefOid: 'abc1234def5678900000000000000000000000aa',
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/1' }],
      }),
    )!;
    observeCiQueue(7, pr);
    vi.mocked(runDetailsCommand).mockResolvedValue({
      state: 'ready',
      checks: [{ name: 'build', step: 'Run tests', log: ['FAIL fractions'], more: 39 }],
    });
    await edit();
    fireEvent.click(screen.getByRole('button', { name: 'Test on the Last Failure' }));
    expect(await screen.findByText(/On PR #14 \(abc1234\), task “Fix fractions”, the item would carry:/)).toBeTruthy();
    expect(screen.getByText('build: step “Run tests”, 1 log line (39 more cut)')).toBeTruthy();
    expect(screen.getByText('FAIL fractions')).toBeTruthy();
    const [proj, cwd, failure] = vi.mocked(runDetailsCommand).mock.calls[0]!;
    expect(proj).toBe(db.project); // the row, as getProject returned it
    expect(cwd).toBe('/wt/recipe-app/fix');
    expect(failure.prNumber).toBe(14);
  });

  it('says so when there is no failure to test on, and runs nothing', async () => {
    db.project = { ...SAVED, ciDetails: 'command', ciDetailsCommand: './scripts/ci-details.sh' };
    await edit();
    fireEvent.click(screen.getByRole('button', { name: 'Test on the Last Failure' }));
    expect(await screen.findByText(/No failure to test on/)).toBeTruthy();
    expect(runDetailsCommand).not.toHaveBeenCalled();
  });
});
