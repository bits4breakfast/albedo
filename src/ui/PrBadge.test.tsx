/**
 * @vitest-environment jsdom
 *
 * Where the PR badge goes, a Create PR button stands in while there is none.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../types';

const state = { answered: true, pr: null as unknown };
vi.mock('../gh/prStore', () => ({
  getPrStatus: () => (state.answered ? state.pr : undefined),
  usePrStatus: () => state.pr,
}));
vi.mock('../git/worktree', () => ({ commitsOnBranch: vi.fn(async () => 3) }));

const wt = await import('../git/worktree');
const { PrBadge } = await import('./PrBadge');

afterEach(() => {
  cleanup();
  state.answered = true;
  state.pr = null;
});

const task = {
  id: 1, title: 't', repoPath: '/r', baseBranch: 'main', branch: 'feat', worktreePath: '/w',
  sessionId: null, status: 'idle', createdAt: 1, lastActivityAt: null, projectId: null,
  ownsWorktree: true, createdBranch: true,
} as unknown as Task;

describe('PrBadge without a PR', () => {
  it('offers Create PR once gh says there is none and the branch has commits', async () => {
    const onCreatePr = vi.fn();
    render(<PrBadge task={task} onCreatePr={onCreatePr} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create PR' }));
    expect(onCreatePr).toHaveBeenCalledTimes(1);
  });

  it('offers nothing before gh has answered, on a detached HEAD, or with no commits', async () => {
    state.answered = false;
    const { rerender } = render(<PrBadge task={task} onCreatePr={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();

    state.answered = true;
    vi.mocked(wt.commitsOnBranch).mockResolvedValueOnce(null);
    rerender(<PrBadge task={{ ...task, worktreePath: '/detached' }} onCreatePr={() => {}} />);
    await waitFor(() => expect(wt.commitsOnBranch).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();

    vi.mocked(wt.commitsOnBranch).mockResolvedValueOnce(0);
    rerender(<PrBadge task={{ ...task, worktreePath: '/empty' }} onCreatePr={() => {}} />);
    await waitFor(() => expect(wt.commitsOnBranch).toHaveBeenCalledWith('/empty', 'main'));
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
  });
});
