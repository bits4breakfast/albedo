/**
 * @vitest-environment jsdom
 *
 * Through the real PR store: the Create PR button must appear when gh's
 * answer arrives. "Not asked yet" and "no PR" read the same to usePrStatus,
 * so a test with a mocked store could not see that it never re-rendered.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Task } from '../types';
import { setPrFetcherForTests } from '../gh/prStore';

vi.mock('../git/worktree', () => ({ commitsOnBranch: vi.fn(async () => 2) }));

const { PrBadge } = await import('./PrBadge');

afterEach(cleanup);

const task = {
  id: 41, title: 't', repoPath: '/r', baseBranch: 'main', branch: 'feat', worktreePath: '/w',
  sessionId: null, status: 'idle', createdAt: 1, lastActivityAt: null, projectId: null,
  ownsWorktree: true, createdBranch: true,
} as unknown as Task;

describe('PrBadge with the real store', () => {
  it('shows Create PR once gh answers that there is no PR', async () => {
    let answer: (v: null) => void = () => {};
    setPrFetcherForTests(() => new Promise((resolve) => (answer = resolve)));
    render(<PrBadge task={task} onCreatePr={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
    answer(null);
    expect(await screen.findByRole('button', { name: 'Create PR' })).toBeTruthy();
  });
});

describe('PrBadge after a turn ends', () => {
  it('asks GitHub again when the task goes from running to idle', async () => {
    const fetcher = vi.fn(async () => null);
    setPrFetcherForTests(fetcher);
    const running = { ...task, id: 42, status: 'running' } as Task;
    const { rerender } = render(<PrBadge task={running} onCreatePr={() => {}} />);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let that fetch settle
    rerender(<PrBadge task={{ ...running, status: 'idle' } as Task} onCreatePr={() => {}} />);
    // Forced past the 15 s reuse window: the turn may have just opened the PR.
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});
