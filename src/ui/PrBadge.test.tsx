/**
 * @vitest-environment jsdom
 *
 * Where the PR badge goes, a Create PR button stands in while there is none.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../types';
import type { PrStatus } from '../gh/prStatus';

const state = { answered: true, pr: null as unknown };
vi.mock('../gh/prStore', () => ({
  getPrStatus: () => (state.answered ? state.pr : undefined),
  usePrStatus: () => state.pr,
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/worktree', () => ({ commitsOnBranch: vi.fn(async () => 3) }));
vi.mock('../lib/openUrl', () => ({ openExternal: vi.fn(async () => {}) }));
vi.mock('./ChecksDialog', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Checks">
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

const wt = await import('../git/worktree');
const { openExternal } = await import('../lib/openUrl');
const { PrBadge, opensChecks } = await import('./PrBadge');
const ci = await import('./ciNotice');
const { __setAttentionBackend } = await import('./attention');

afterEach(() => {
  cleanup();
  ci.resetCiNoticesForTests();
  __setAttentionBackend(null);
  state.answered = true;
  state.pr = null;
  vi.clearAllMocks();
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

  it('offers nothing before gh has answered, for a branch git does not know, or with no commits', async () => {
    state.answered = false;
    const { rerender } = render(<PrBadge task={task} onCreatePr={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();

    state.answered = true;
    vi.mocked(wt.commitsOnBranch).mockResolvedValueOnce(null);
    rerender(<PrBadge task={{ ...task, branch: 'gone' }} onCreatePr={() => {}} />);
    await waitFor(() => expect(wt.commitsOnBranch).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();

    vi.mocked(wt.commitsOnBranch).mockResolvedValueOnce(0);
    rerender(<PrBadge task={{ ...task, branch: 'empty' }} onCreatePr={() => {}} />);
    await waitFor(() => expect(wt.commitsOnBranch).toHaveBeenCalledWith('/r', 'main', 'empty'));
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
  });
});

describe('PrBadge with a PR', () => {
  const pr = (over: Partial<PrStatus>): PrStatus => ({
    number: 6,
    url: 'https://github.com/o/r/pull/6',
    title: 't',
    state: 'open',
    headRefName: 'feat',
    baseRefName: 'main',
    headSha: '',
    mergedAt: null,
    review: null,
    checks: { kind: 'failing', failing: 1, total: 1 },
    lines: [{ name: 'CI / linux', bucket: 'fail', url: 'https://github.com/o/r/actions/runs/1/job/2' }],
    ...over,
  });

  it('opens the Checks dialog from an open PR with checks, and gives focus back on close', () => {
    state.pr = pr({});
    render(<PrBadge task={task} />);
    const badge = screen.getByRole('button', { name: /Pull request 6, 1 Failing\. Show the checks/ });
    expect(badge.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(badge);
    expect(screen.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(badge);
  });

  it('opens GitHub, as before, once merged or with no checks', () => {
    expect(opensChecks(pr({ state: 'merged' }))).toBe(false);
    expect(opensChecks(pr({ state: 'closed' }))).toBe(false);
    expect(opensChecks(pr({ lines: [], checks: { kind: 'none' } }))).toBe(false);
    expect(opensChecks(pr({ state: 'draft' }))).toBe(true);
    state.pr = pr({ lines: [], checks: { kind: 'none' } });
    render(<PrBadge task={task} />);
    fireEvent.click(screen.getByRole('button', { name: /Open on GitHub/ }));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/pull/6');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('PrBadge and finished checks (#159)', () => {
  const pr = (failing: boolean, sha = 'a'): PrStatus => ({
    number: 6, url: 'https://github.com/o/r/pull/6', title: 't', state: 'open', headRefName: 'feat', baseRefName: 'main',
    headSha: sha, mergedAt: null, review: null,
    checks: failing ? { kind: 'failing', failing: 1, total: 1 } : { kind: 'pending', pending: 1, total: 1 },
    lines: [{ name: 'CI / linux', bucket: failing ? 'fail' : 'pending', url: null }],
  });

  it('opens the Checks dialog when a "checks failed" banner was clicked for this task', () => {
    state.pr = pr(true);
    ci.requestChecks(1);
    render(<PrBadge task={task} />);
    expect(screen.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
  });

  it('leaves another task\'s request alone', () => {
    state.pr = pr(true);
    ci.requestChecks(2);
    render(<PrBadge task={task} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cues the badge when checks finish on the open task, then lets it go', () => {
    vi.useFakeTimers();
    __setAttentionBackend(() => {}, true, () => {});
    state.pr = pr(true);
    render(<PrBadge task={task} />);
    const badge = screen.getByRole('button', { name: /Pull request 6/ });
    expect(badge.getAttribute('data-cue')).toBeNull();
    act(() => {
      ci.observeCi(task, pr(false), 1);
      ci.observeCi(task, pr(true), 1);
    });
    expect(badge.getAttribute('data-cue')).toBe('fail');
    expect(screen.getByRole('status').textContent).toBe('Checks failed on pull request 6');
    act(() => {
      vi.advanceTimersByTime(ci.CI_CUE_MS);
    });
    expect(badge.getAttribute('data-cue')).toBeNull();
    vi.useRealTimers();
  });
});
