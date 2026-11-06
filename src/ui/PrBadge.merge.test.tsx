/**
 * @vitest-environment jsdom
 *
 * The PR's one action in the task bar (#236): Squash and Merge… opens a
 * confirm and Albedo merges; ⚠ Conflicts hands Claude the rebase; approved but
 * not mergeable says why. Driven through the rendered buttons.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../types';
import { parsePrView, type PrStatus } from '../gh/prStatus';

const state = { pr: null as PrStatus | null };
const refreshPrStatus = vi.fn(async () => {});
vi.mock('../gh/prStore', () => ({
  getPrStatus: () => state.pr,
  usePrStatus: () => state.pr,
  usePrStatusVersion: () => 0,
  useViewerLogin: () => null,
  refreshPrStatus: (...a: unknown[]) => refreshPrStatus(...(a as [])),
}));
vi.mock('../git/worktree', () => ({ commitsOnBranch: vi.fn(async () => 3) }));
vi.mock('../lib/openUrl', () => ({ openExternal: vi.fn(async () => {}) }));
const mergePr = vi.fn();
vi.mock('../gh/gh', async () => ({
  ...(await vi.importActual<typeof import('../gh/gh')>('../gh/gh')),
  mergePr: (...a: unknown[]) => mergePr(...a),
}));

const { PrBadge } = await import('./PrBadge');

const task = {
  id: 1, title: 'Fix login retry', repoPath: '/r', baseBranch: 'main', branch: 'feat', worktreePath: '/w',
  sessionId: null, status: 'idle', createdAt: 1, lastActivityAt: null, projectId: null,
  ownsWorktree: true, createdBranch: true,
} as unknown as Task;

function pr(o: { decision?: string; mergeable?: string; mergeState?: string; isDraft?: boolean; head?: string } = {}): PrStatus {
  return parsePrView(
    JSON.stringify({
      number: 21,
      title: 'Fix login retry',
      state: 'OPEN',
      isDraft: o.isDraft ?? false,
      headRefName: 'feat',
      headRefOid: o.head ?? 'aaaaaaa1',
      baseRefName: 'main',
      reviewDecision: o.decision ?? 'APPROVED',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 't', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      mergeable: o.mergeable ?? 'MERGEABLE',
      mergeStateStatus: o.mergeState ?? 'CLEAN',
    }),
  )!;
}

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
});
afterEach(() => {
  cleanup();
  state.pr = null;
  vi.clearAllMocks();
});

const mergeButton = () => screen.queryByRole('button', { name: 'Squash and Merge…' });
const conflictsButton = () => screen.queryByRole('button', { name: /Conflicts/ });

describe('Squash and Merge… (#236)', () => {
  it('shows only when approved, green and clean', () => {
    state.pr = pr({ decision: 'REVIEW_REQUIRED' });
    const { rerender } = render(<PrBadge task={task} />);
    expect(mergeButton()).toBeNull();
    state.pr = pr();
    rerender(<PrBadge task={{ ...task }} />);
    expect(mergeButton()).not.toBeNull();
  });

  it('asks first, with the branch deletion ticked; confirming merges and refreshes that task', async () => {
    state.pr = pr();
    mergePr.mockResolvedValue({ ok: true });
    render(<PrBadge task={task} />);
    fireEvent.click(mergeButton()!);
    const dialog = screen.getByRole('dialog', { name: 'Squash and Merge PR #21?' });
    expect(mergePr).not.toHaveBeenCalled();
    expect(await screen.findByText('3 commits become one')).toBeTruthy();
    const box = screen.getByRole('checkbox', { name: 'Delete the branch on GitHub after merging' }) as HTMLInputElement;
    expect(box.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Squash and Merge' }));
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(mergePr).toHaveBeenCalledWith(state.pr, task, { deleteBranch: true });
    expect(refreshPrStatus).toHaveBeenCalledWith(task, { force: true });
  });

  it('remembers an unticked branch deletion, and merges without it', async () => {
    state.pr = pr();
    mergePr.mockResolvedValue({ ok: true });
    render(<PrBadge task={task} />);
    fireEvent.click(mergeButton()!);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete the branch on GitHub after merging' }));
    fireEvent.click(screen.getByRole('button', { name: 'Squash and Merge' }));
    await waitFor(() => expect(mergePr).toHaveBeenCalledWith(state.pr, task, { deleteBranch: false }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(mergeButton()!);
    expect((screen.getByRole('checkbox', { name: 'Delete the branch on GitHub after merging' }) as HTMLInputElement).checked).toBe(false);
  });

  it('merges the PR as it was when the dialog opened, even if a poll brings a new head', async () => {
    state.pr = pr({ head: 'aaaaaaa1' });
    const shown = state.pr;
    mergePr.mockResolvedValue({ ok: true });
    const { rerender } = render(<PrBadge task={task} />);
    fireEvent.click(mergeButton()!);
    // A push lands while the dialog is open.
    state.pr = pr({ head: 'bbbbbbb2' });
    rerender(<PrBadge task={task} />);
    fireEvent.click(screen.getByRole('button', { name: 'Squash and Merge' }));
    await waitFor(() => expect(mergePr).toHaveBeenCalled());
    expect(mergePr.mock.calls[0]![0]).toBe(shown);
    expect((mergePr.mock.calls[0]![0] as PrStatus).headSha).toBe('aaaaaaa1');
  });

  it("a refusal shows GitHub's message in the dialog, and nothing else happens", async () => {
    state.pr = pr();
    mergePr.mockResolvedValue({ ok: false, message: 'Pull request #21 is not mergeable: the base branch policy prohibits the merge.' });
    const onEnd = vi.fn();
    render(<PrBadge task={task} onEnd={onEnd} />);
    fireEvent.click(mergeButton()!);
    fireEvent.click(screen.getByRole('button', { name: 'Squash and Merge' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('the base branch policy prohibits the merge');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onEnd).not.toHaveBeenCalled();
    // GitHub's answer decides the badge, not this one.
    expect(refreshPrStatus).toHaveBeenCalledWith(task, { force: true });
  });
});

describe('⚠ Conflicts (#236)', () => {
  it('hands the PR to onResolveConflicts, and outranks Merge', () => {
    state.pr = pr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
    const onResolveConflicts = vi.fn();
    render(<PrBadge task={task} onResolveConflicts={onResolveConflicts} />);
    expect(mergeButton()).toBeNull();
    fireEvent.click(conflictsButton()!);
    expect(onResolveConflicts).toHaveBeenCalledWith(state.pr);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows on a draft and on an unapproved PR too', () => {
    state.pr = pr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY', isDraft: true, decision: 'REVIEW_REQUIRED' });
    render(<PrBadge task={task} onResolveConflicts={() => {}} />);
    expect(conflictsButton()).not.toBeNull();
  });
});

describe('approved, but not mergeable yet (#236)', () => {
  it('says why in words, never a disabled button', () => {
    state.pr = pr({ mergeState: 'BLOCKED' });
    render(<PrBadge task={task} onResolveConflicts={() => {}} />);
    expect(screen.getByText('Can’t merge yet: a branch rule blocks it')).toBeTruthy();
    expect(mergeButton()).toBeNull();
    expect(conflictsButton()).toBeNull();
  });

  it('says nothing while GitHub is still computing', () => {
    state.pr = pr({ mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' });
    const { container } = render(<PrBadge task={task} onResolveConflicts={() => {}} />);
    expect(container.querySelector('.pr-action, .pr-reason')).toBeNull();
  });
});
