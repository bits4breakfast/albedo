/**
 * @vitest-environment jsdom
 *
 * Archiving a chat (#49): it made no worktree and no branch, so nothing is
 * probed, nothing is offered for removal, and confirming only closes it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../types';

const removeWorktree = vi.fn(async () => {});
const probeWorkAtRisk = vi.fn();
const mayDeleteTaskBranch = vi.fn();

vi.mock('../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git/worktree')>()),
  removeWorktree,
  probeWorkAtRisk,
  mayDeleteTaskBranch,
}));
vi.mock('../lsp/phpantom', () => ({ stopPhpantom: async () => {} }));

const { ArchiveTaskDialog } = await import('./ArchiveTaskDialog');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const chat: Task = {
  id: 7, title: 'How does the retry work?', projectId: 1, repoPath: '/r/app', baseBranch: '', branch: '',
  worktreePath: '/r/app', sessionId: 's', ownsWorktree: false, createdBranch: false, kind: 'chat',
  status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: null,
};

describe('ArchiveTaskDialog on a chat', () => {
  it('offers nothing to remove and archives without touching git', async () => {
    const onArchived = vi.fn();
    render(<ArchiveTaskDialog task={chat} onClose={() => {}} onArchived={onArchived} />);
    expect(screen.getByRole('heading', { name: 'Archive Task' })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText(/created no worktree and no\s+branch/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Archive Task' }));
    await waitFor(() => expect(onArchived).toHaveBeenCalledWith(7));
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(probeWorkAtRisk).not.toHaveBeenCalled();
    expect(mayDeleteTaskBranch).not.toHaveBeenCalled();
  });

  it('removes nothing on delete either, even with a stray ownsWorktree', async () => {
    const onDeleted = vi.fn();
    render(
      <ArchiveTaskDialog
        task={{ ...chat, ownsWorktree: true }}
        intent="delete"
        onClose={() => {}}
        onArchived={() => {}}
        onDeleted={onDeleted}
      />,
    );
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Task' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(7));
    expect(removeWorktree).not.toHaveBeenCalled();
  });
});
