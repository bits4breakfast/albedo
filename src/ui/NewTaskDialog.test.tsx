/**
 * @vitest-environment jsdom
 *
 * The partial create: `createWorktree` succeeded, `createTask` threw. Before,
 * the worktree stayed on disk with no task naming it and every retry failed
 * `path-exists`. Now the dialog undoes it and says so.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/Users/m' }));
vi.mock('./ProjectsDialog', () => ({ default: () => null }));
vi.mock('../capture/modelCatalog', () => ({
  loadModelChoices: async () => [],
  loadDefaultModel: async () => null,
}));
vi.mock('../db', () => ({ createTask: vi.fn(async () => { throw new Error('database is locked'); }) }));
vi.mock('../db/projects', () => ({
  listProjects: vi.fn(async () => [
    {
      id: 1,
      name: 'albedo',
      repoPath: '/Users/m/www/albedo',
      worktreeRoot: '/Users/m/agents/albedo',
      defaultBaseBranch: 'main',
      createdAt: 1,
    },
  ]),
}));
vi.mock('./projectPrefs', () => ({
  readLastProjectId: vi.fn(() => null),
  writeLastProjectId: vi.fn(),
}));
vi.mock('../git/worktree', async (orig) => ({
  ...(await orig<typeof import('../git/worktree')>()),
  createWorktree: vi.fn(async () => undefined),
  listBranches: vi.fn(async () => ({ current: 'main', all: ['main'] })),
  undoCreateWorktree: vi.fn(async () => null),
}));

const wt = await import('../git/worktree');
const { NewTaskDialog } = await import('./NewTaskDialog');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function submitWithTitle(title: string) {
  const onCreated = vi.fn();
  render(<NewTaskDialog open onClose={() => {}} onCreated={onCreated} />);
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: title } });
  const create = screen.getByRole('button', { name: 'Create worktree' });
  await waitFor(() => expect(create).not.toHaveProperty('disabled', true));
  fireEvent.click(create);
  return onCreated;
}

describe('NewTaskDialog partial create', () => {
  it('undoes the worktree it just created when the task row cannot be written', async () => {
    const onCreated = await submitWithTitle('Fix login');
    await waitFor(() => expect(wt.undoCreateWorktree).toHaveBeenCalledTimes(1));
    expect(vi.mocked(wt.undoCreateWorktree).mock.calls[0]?.[0]).toMatchObject({
      repoPath: '/Users/m/www/albedo',
      useExistingBranch: false,
    });
    expect(onCreated).not.toHaveBeenCalled();
    await screen.findByText('The task could not be saved');
    expect(screen.getByText(/has been removed again/)).toBeTruthy();
  });

  it('names what was left behind when the undo could not finish', async () => {
    vi.mocked(wt.undoCreateWorktree).mockResolvedValueOnce('The worktree at /x was left on disk.');
    await submitWithTitle('Fix login');
    await screen.findByText(/was left on disk/);
  });
});

describe('NewTaskDialog default project', () => {
  it('starts on the project tab the list is showing, not the last one used', async () => {
    const { listProjects } = await import('../db/projects');
    const base = { worktreeRoot: '/w', defaultBaseBranch: 'main' };
    vi.mocked(listProjects).mockResolvedValueOnce([
      { ...base, id: 1, name: 'albedo', repoPath: '/Users/m/www/albedo', createdAt: 1 },
      { ...base, id: 2, name: 'upsellguru', repoPath: '/Users/m/www/upsellguru', createdAt: 2 },
    ] as never);
    const prefs = await import('./projectPrefs');
    vi.mocked(prefs.readLastProjectId).mockReturnValueOnce(2);
    render(<NewTaskDialog open onClose={() => {}} onCreated={() => {}} defaultProjectId={1} />);
    await waitFor(() =>
      expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('1'),
    );
  });
});
