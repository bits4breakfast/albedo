/**
 * @vitest-environment jsdom
 *
 * The Files head: a group-by toggle always, ⋯ only when it holds an action.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../types';

vi.mock('../gh/prStore', () => ({ getPrStatus: () => null, usePrStatus: () => null }));

const { default: GitBar } = await import('./GitBar');

afterEach(cleanup);

const task = {
  id: 1, title: 't', repoPath: '/r', baseBranch: 'main', branch: 'feat', worktreePath: '/w',
  sessionId: null, status: 'idle', createdAt: 1, lastActivityAt: null, projectId: null,
  ownsWorktree: true, createdBranch: true,
} as unknown as Task;

const bar = (over: Partial<Parameters<typeof GitBar>[0]> = {}) => (
  <GitBar task={task} commits={0} dirty={0} remote={null} onAsk={() => {}} onSquash={() => {}} mode="branch" onMode={() => {}} {...over} />
);

describe('GitBar head controls', () => {
  it('toggles the grouping, naming what a click does', () => {
    const onMode = vi.fn();
    const { rerender } = render(bar({ onMode }));
    fireEvent.click(screen.getByRole('button', { name: 'Group by Commit' }));
    expect(onMode).toHaveBeenCalledWith('commit');
    rerender(bar({ onMode, mode: 'commit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Group by Branch' }));
    expect(onMode).toHaveBeenLastCalledWith('branch');
  });

  it('shows ⋯ only when there is an action in it', () => {
    render(bar());
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    cleanup();
    // Commits on a branch Albedo can squash: Squash & Rebase goes in the menu.
    render(bar({ commits: 2, remote: { ahead: 0, upstream: 'origin/feat', detached: false } }));
    expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy();
  });
});
