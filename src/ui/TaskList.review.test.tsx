/**
 * @vitest-environment jsdom
 *
 * The row mark for a review that landed unseen (#180): Approved or Changes,
 * beside the checks' mark, never on the selected row, gone once the task is
 * opened. Awaiting Review never marks a row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetViewerLoginForTests } from '../gh/gh';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Task } from '../types';
import { parsePrView, type PrStatus } from '../gh/prStatus';

vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));

Element.prototype.scrollIntoView = () => {};

const { default: TaskList } = await import('./TaskList');
const rn = await import('./reviewNotice');
const ci = await import('./ciNotice');
const { __setAttentionBackend } = await import('./attention');

const pr = (decision: string, reviews: { login: string; state: string }[]): PrStatus =>
  parsePrView(
    JSON.stringify({
      number: 21,
      state: 'OPEN',
      headRefName: 'b',
      reviewDecision: decision,
      latestReviews: reviews.map((r) => ({ author: { login: r.login }, state: r.state, submittedAt: 't1' })),
    }),
  ) as PrStatus;

const row = (id: number, title: string): Task =>
  ({
    id, title, projectId: 1, repoPath: '/r/app', sessionId: null, createdBranch: false, baseBranch: 'main',
    ownsWorktree: true, kind: 'work', status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: 1, branch: `b${id}`,
    worktreePath: `/w/${id}`,
  }) as Task;
const tasks = [row(1, 'Fix login'), row(2, 'Write docs')];

beforeEach(() => {
  rn.resetReviewNoticesForTests();
  // Signed in as someone who is not the reviewer: unknown holds reviews back.
  resetViewerLoginForTests('me');
  ci.resetCiNoticesForTests();
  __setAttentionBackend(() => {}, true, () => {});
});
afterEach(() => {
  cleanup();
  __setAttentionBackend(null);
});

function land(task: Task, after: PrStatus, selectedId: number | null) {
  act(() => {
    rn.observeReview(task, pr('REVIEW_REQUIRED', []), selectedId);
    rn.observeReview(task, after, selectedId);
  });
}

describe('TaskList: unseen reviews', () => {
  it('marks an approval with ✓ Approved and names the reviewer', () => {
    const { container } = render(<TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    expect(container.querySelector('.task-review')).toBeNull();
    land(tasks[0]!, pr('APPROVED', [{ login: 'alice', state: 'APPROVED' }]), 2);
    const mark = screen.getByRole('img', { name: 'PR #21 approved by alice, not seen yet' });
    expect(mark.textContent).toBe('✓ Approved');
    expect(mark.getAttribute('data-outcome')).toBe('approved');
    expect(container.querySelector('[data-task-id="1"] .task-review')).toBe(mark);
  });

  it('marks changes requested with ✎ Changes', () => {
    render(<TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    land(tasks[0]!, pr('CHANGES_REQUESTED', [{ login: 'carol', state: 'CHANGES_REQUESTED' }]), 2);
    const mark = screen.getByRole('img', { name: 'Changes requested on PR #21 by carol, not seen yet' });
    expect(mark.textContent).toBe('✎ Changes');
  });

  it('never marks the selected row, nor Awaiting Review; opening the task clears the mark', () => {
    const { container, rerender } = render(
      <TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />,
    );
    land(tasks[1]!, pr('APPROVED', [{ login: 'alice', state: 'APPROVED' }]), 2);
    // A reviewer asked, nobody answered yet: still the default state.
    land(tasks[0]!, pr('REVIEW_REQUIRED', [{ login: 'bot', state: 'COMMENTED' }]), 2);
    expect(container.querySelector('.task-review')).toBeNull();

    land(tasks[0]!, pr('APPROVED', [{ login: 'alice', state: 'APPROVED' }]), 2);
    expect(container.querySelector('[data-task-id="1"] .task-review')).not.toBeNull();
    act(() => rn.clearReviewMark(1));
    rerender(<TaskList tasks={tasks} selectedId={1} onSelect={() => {}} onNew={() => {}} />);
    expect(container.querySelector('.task-review')).toBeNull();
  });
});
