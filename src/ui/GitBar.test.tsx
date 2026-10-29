/**
 * @vitest-environment jsdom
 *
 * The Files head: a group-by toggle always, ⋯ only when it holds an action.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../types';

// null: gh answered, no PR. undefined: gh has not answered yet.
let prStatus: null | undefined = null;
vi.mock('../gh/prStore', () => ({ getPrStatus: () => prStatus, usePrStatus: () => null }));

const { default: GitBar } = await import('./GitBar');

afterEach(() => {
  cleanup();
  prStatus = null;
});

const task = {
  id: 1, title: 't', repoPath: '/r', baseBranch: 'main', branch: 'feat', worktreePath: '/w',
  sessionId: null, status: 'idle', createdAt: 1, lastActivityAt: null, projectId: null,
  ownsWorktree: true, createdBranch: true, kind: 'work',
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

  it('offers Create PR first for a branch with no PR, and Push in ⋯ (#124)', () => {
    render(bar({ dirty: 4, remote: { ahead: 0, upstream: null, detached: false } }));
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByText('Push')).toBeTruthy();
  });

  it('offers Push while gh has not said whether a PR exists', () => {
    prStatus = undefined;
    render(bar({ dirty: 4, remote: { ahead: 0, upstream: null, detached: false } }));
    expect(screen.getByRole('button', { name: /Push/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
  });
});

describe('GitBar on a chat task', () => {
  // The main checkout as it is: no branch of its own, nothing to push from.
  const chat = { ...task, kind: 'chat', branch: '', baseBranch: '', ownsWorktree: false, createdBranch: false } as Task;

  it('offers no Push, Create PR or Squash, and no ⋯ to hold them', () => {
    render(bar({ task: chat, dirty: 3, commits: 2, remote: { ahead: 2, upstream: 'origin/main', detached: false } }));
    expect(screen.queryByRole('button', { name: /Push/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('keeps the view controls', () => {
    const onView = vi.fn();
    render(bar({ task: chat, dirty: 3, onView }));
    expect(screen.getByRole('button', { name: 'Group by Commit' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show All Files' }));
    expect(onView).toHaveBeenCalledWith('project');
  });
});
