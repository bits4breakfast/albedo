/**
 * @vitest-environment jsdom
 *
 * Archiving a task whose PHPantom start failed (#73). The pool is the real
 * one; only Tauri's fs, shell and path plugins are faked, with the config
 * write refused the way the fs scope refused it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../types';

const removeWorktree = vi.fn(async () => {});
const probeWorkAtRisk = vi.fn(async () => ({
  risk: { files: [], ahead: 0, aheadBase: 'main', head: 'abc' },
  filesError: null,
  aheadError: null,
}));
const mayDeleteTaskBranch = vi.fn(async () => true);

vi.mock('../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git/worktree')>()),
  removeWorktree,
  probeWorkAtRisk,
  mayDeleteTaskBranch,
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: {} }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => true),
  mkdir: vi.fn(async () => {}),
  writeTextFile: vi.fn(async () => {
    throw new Error('forbidden path: /home/me/.albedo/phpantom/phpantom_lsp/.phpantom.toml');
  }),
  watch: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/home/me' }));

const { phpantomFor } = await import('../lsp/phpantom');
const { ArchiveTaskDialog } = await import('./ArchiveTaskDialog');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const task: Task = {
  id: 9, title: 'Fix the importer', projectId: 1, repoPath: '/r/app', baseBranch: 'main', branch: 'fix-importer',
  worktreePath: '/wt/fix-importer', sessionId: 's', ownsWorktree: true, createdBranch: true, kind: 'work',
  status: 'idle', createdAt: 1, lastActivityAt: 1,
};

describe('ArchiveTaskDialog after a failed PHPantom start', () => {
  it('removes the worktree and archives the task', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await phpantomFor(task.worktreePath)).toBeNull();

    const onArchived = vi.fn();
    render(<ArchiveTaskDialog task={task} onClose={() => {}} onArchived={onArchived} />);
    await waitFor(() => expect(probeWorkAtRisk).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Archive and Remove Worktree' }));
    await waitFor(() => expect(onArchived).toHaveBeenCalledWith(9));
    expect(removeWorktree).toHaveBeenCalledOnce();
    expect(screen.queryByText(/not a git failure/)).toBeNull();
  });
});
