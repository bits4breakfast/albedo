/**
 * @vitest-environment jsdom
 *
 * Create PR's commit count as the session writes (#365): counted at once for
 * a task, then at most once per RECOUNT_MIN_MS however often the transcript
 * grows, and always once more after the last write. The button stays on
 * screen between counts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Task } from '../types';

vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrStatus: () => null,
  usePrStatusVersion: () => 0,
  useViewerLogin: () => null,
  refreshPrStatus: async () => {},
}));
const counts = vi.hoisted(() => ({ n: 0 }));
vi.mock('../git/worktree', () => ({ commitsOnBranch: vi.fn(async () => counts.n) }));
vi.mock('../git/stackBase', () => ({ detectStackBase: async () => null }));

const wt = await import('../git/worktree');
const { PrBadge, RECOUNT_MIN_MS } = await import('./PrBadge');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  counts.n = 0;
});

const base = {
  id: 1, title: 't', repoPath: '/r', baseBranch: 'main', branch: 'feat', worktreePath: '/w',
  sessionId: null, status: 'running', createdAt: 1, lastActivityAt: 1000, projectId: null,
  ownsWorktree: true, createdBranch: true, kind: 'work',
} as unknown as Task;

const flush = () => act(async () => {});

describe('PrBadge: the commit count behind Create PR (#365)', () => {
  it('counts once per window while the session writes, and after the last write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
    counts.n = 1;
    const { rerender } = render(<PrBadge task={base} onCreatePr={() => {}} />);
    await flush();
    expect(wt.commitsOnBranch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Create PR' }).title).toContain('(1 commit)');

    // Fifteen writes in one and a half seconds: none counted yet, the button stays.
    expect(RECOUNT_MIN_MS).toBe(2_000);
    counts.n = 2;
    for (let i = 1; i <= 15; i++) {
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      rerender(<PrBadge task={{ ...base, lastActivityAt: 1000 + i } as Task} onCreatePr={() => {}} />);
      await flush();
      expect(screen.getByRole('button', { name: 'Create PR' })).toBeTruthy();
    }
    expect(wt.commitsOnBranch).toHaveBeenCalledTimes(1);

    // The window closes: the last write is counted.
    await act(async () => {
      vi.advanceTimersByTime(RECOUNT_MIN_MS);
    });
    await flush();
    expect(wt.commitsOnBranch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Create PR' }).title).toContain('(2 commits)');

    // A write after a quiet spell is counted at once.
    counts.n = 3;
    await act(async () => {
      vi.advanceTimersByTime(RECOUNT_MIN_MS * 2);
    });
    rerender(<PrBadge task={{ ...base, lastActivityAt: 5000 } as Task} onCreatePr={() => {}} />);
    await flush();
    expect(wt.commitsOnBranch).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'Create PR' }).title).toContain('(3 commits)');
  });

  it('counts another task, or another branch, at once and never shows the old count for it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
    counts.n = 4;
    const { rerender } = render(<PrBadge task={base} onCreatePr={() => {}} />);
    await flush();
    expect(screen.getByRole('button', { name: 'Create PR' }).title).toContain('(4 commits)');
    counts.n = 0;
    rerender(<PrBadge task={{ ...base, id: 2 } as Task} onCreatePr={() => {}} />);
    await flush();
    expect(wt.commitsOnBranch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
    counts.n = 5;
    rerender(<PrBadge task={{ ...base, id: 2, branch: 'other' } as Task} onCreatePr={() => {}} />);
    await flush();
    expect(wt.commitsOnBranch).toHaveBeenLastCalledWith('/r', 'main', 'other');
    expect(screen.getByRole('button', { name: 'Create PR' }).title).toContain('(5 commits)');
  });
});
