/**
 * @vitest-environment jsdom
 *
 * The Files head: a group-by toggle always, ⋯ only when it holds an action.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../types';

// null: gh answered, no PR. undefined: gh has not answered yet.
let prStatus: null | undefined = null;
vi.mock('../gh/prStore', () => ({ getPrStatus: () => prStatus, usePrStatus: () => null }));

const { default: GitBar } = await import('./GitBar');
const { setReviewGateForTests, resetGateForTests } = await import('../guide/gate');
const { onGuideRequest } = await import('../guide/openGuide');
const { draftRecordOf } = await import('../gh/draftReady');

/** A fresh in-memory store per test (REGRESSIONS: never the runtime's localStorage). */
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
  // Your own review done (#464), unless a test says otherwise.
  setReviewGateForTests(() => ({ kind: 'ready', total: 2 }));
});

afterEach(() => {
  cleanup();
  prStatus = null;
  resetGateForTests();
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
  it('has no Review Guide button: the Guide tab is beside Files (#335)', () => {
    render(bar());
    expect(screen.queryByRole('button', { name: 'Review Guide' })).toBeNull();
  });

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

describe('GitBar: review before Create PR (#464)', () => {
  const branch = { dirty: 4, remote: { ahead: 0, upstream: null, detached: false } } as const;

  it('offers Review Changes with how far along, opening the Guide, until every group is Reviewed', () => {
    setReviewGateForTests(() => ({ kind: 'reviewing', reviewed: 4, total: 6 }));
    const asked: number[] = [];
    const off = onGuideRequest((id) => asked.push(id));
    const onAsk = vi.fn();
    render(bar({ ...branch, onAsk }));
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
    const review = screen.getByRole('button', { name: 'Review Changes · 4 of 6' });
    expect(review.title).toMatch(/2 of 6 groups are not marked Reviewed yet/);
    fireEvent.click(review);
    expect(asked).toEqual([task.id]);
    expect(onAsk).not.toHaveBeenCalled();
    off();
  });

  it('says "out of date" for a guide the branch moved on from, and "no guide" without one', () => {
    setReviewGateForTests(() => ({ kind: 'stale', commitsSince: 2 }));
    render(bar(branch));
    expect(screen.getByRole('button', { name: 'Review Changes · out of date' }).title).toMatch(/2 commits since it was written/);
    cleanup();
    setReviewGateForTests(() => ({ kind: 'no-guide' }));
    render(bar(branch));
    expect(screen.getByRole('button', { name: 'Review Changes · no guide' })).toBeTruthy();
  });

  it('Create PR comes back once reviewed, asks for a draft and remembers it', () => {
    const onAsk = vi.fn();
    render(bar({ ...branch, onAsk }));
    fireEvent.click(screen.getByRole('button', { name: 'Create PR' }));
    expect(onAsk).toHaveBeenCalledWith(expect.stringContaining('gh pr create --draft'));
    expect(draftRecordOf(task.id)).toMatchObject({ escape: false, done: [] });
    // Nothing in ⋯ to skip the review: there is none to skip.
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByText('Create PR without Review…')).toBeNull();
  });

  it('Create PR without Review… in ⋯ asks first; Cancel sends nothing, Create PR sends the same draft PR', () => {
    setReviewGateForTests(() => ({ kind: 'reviewing', reviewed: 1, total: 3 }));
    const onAsk = vi.fn();
    render(bar({ ...branch, onAsk }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Create PR without Review…/ }));
    const dialog = screen.getByRole('dialog', { name: 'Create PR Without Review?' });
    expect(dialog.textContent).toMatch(/2 of 3 groups are not marked Reviewed yet/);
    // Focus starts on Cancel: skipping the review is chosen on purpose.
    expect(document.activeElement?.textContent).toBe('Cancel');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onAsk).not.toHaveBeenCalled();
    expect(draftRecordOf(task.id)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Create PR without Review…/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create PR' }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onAsk.mock.calls[0]![0]).toContain('gh pr create --draft');
    expect(draftRecordOf(task.id)).toMatchObject({ escape: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape closes the confirmation without sending', () => {
    setReviewGateForTests(() => ({ kind: 'no-guide' }));
    const onAsk = vi.fn();
    render(bar({ ...branch, onAsk }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Create PR without Review…/ }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onAsk).not.toHaveBeenCalled();
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
