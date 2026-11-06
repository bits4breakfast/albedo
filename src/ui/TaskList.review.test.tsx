/**
 * @vitest-environment jsdom
 *
 * The row's review mark. Approved is state (#234): shown while the open PR
 * is approved, on the selected row too, until it is merged -- but not in the
 * Approved group, which says it (#278). Changes is news (#180): an unseen
 * change request, never on the selected row, gone once the task is opened,
 * and not in In Review, whose chip says it (#278). Awaiting Review never
 * marks a row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetViewerLoginForTests } from '../gh/gh';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Task } from '../types';
import { parsePrView, type PrStatus } from '../gh/prStatus';

const prs = new Map<number, PrStatus | null>();
vi.mock('../gh/prStore', () => ({
  getPrStatus: (id: number) => prs.get(id) ?? null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));

Element.prototype.scrollIntoView = () => {};

const { default: TaskList } = await import('./TaskList');
const rn = await import('./reviewNotice');
const ci = await import('./ciNotice');
const { __setAttentionBackend } = await import('./attention');

const pr = (decision: string, reviews: { login: string; state: string }[], state = 'OPEN', isDraft = false): PrStatus =>
  parsePrView(
    JSON.stringify({
      number: 21,
      state,
      isDraft,
      headRefName: 'b',
      reviewDecision: decision,
      latestReviews: reviews.map((r) => ({ author: { login: r.login }, state: r.state, submittedAt: 't1' })),
    }),
  ) as PrStatus;

const row = (id: number, title: string): Task =>
  ({
    id, title, projectId: 1, repoPath: '/r/app', sessionId: null, createdBranch: false, baseBranch: 'main',
    ownsWorktree: true, kind: 'work', status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: 1, summary: null, branch: `b${id}`,
    worktreePath: `/w/${id}`,
  }) as Task;
const tasks = [row(1, 'Fix login'), row(2, 'Write docs')];
/**
 * Task 1 at work: an approved PR on a running task is in Running, where the
 * row's mark is the only place it shows. At rest it would be in Approved.
 */
const working = [{ ...tasks[0]!, status: 'running' as const }, tasks[1]!];

beforeEach(() => {
  prs.clear();
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

const approved = () => pr('APPROVED', [{ login: 'alice', state: 'APPROVED' }]);

describe('TaskList: an approval that stands (#234)', () => {
  it('shows ✓ Approved from the PR as it is, naming the reviewer', () => {
    prs.set(1, approved());
    const { container } = render(<TaskList tasks={working} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    const mark = screen.getByRole('img', { name: 'PR #21 approved by alice, ready to merge' });
    expect(mark.textContent).toBe('✓ Approved');
    expect(mark.getAttribute('data-outcome')).toBe('approved');
    expect(mark.getAttribute('title')).toBe('PR #21 approved by alice. Ready to merge.');
    expect(container.querySelector('[data-task-id="1"] .task-review')).toBe(mark);
  });

  it('stays on the selected row, and after the task is opened', () => {
    prs.set(1, approved());
    land(working[0]!, approved(), 2);
    const { container, rerender } = render(<TaskList tasks={working} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    act(() => rn.clearReviewMark(1));
    rerender(<TaskList tasks={working} selectedId={1} onSelect={() => {}} onNew={() => {}} />);
    expect(container.querySelector('[data-task-id="1"] .task-review')?.textContent).toBe('✓ Approved');
  });

  it('with no review event at all: a restart, or an approval from before launch', () => {
    prs.set(1, approved());
    const { container } = render(<TaskList tasks={working} selectedId={1} onSelect={() => {}} onNew={() => {}} />);
    expect(container.querySelector('[data-task-id="1"] .task-review')).not.toBeNull();
  });

  it.each([
    ['merged', pr('APPROVED', [{ login: 'alice', state: 'APPROVED' }], 'MERGED')],
    ['closed', pr('APPROVED', [{ login: 'alice', state: 'APPROVED' }], 'CLOSED')],
    ['a draft', pr('APPROVED', [{ login: 'alice', state: 'APPROVED' }], 'OPEN', true)],
    ['dismissed by a push', pr('REVIEW_REQUIRED', [])],
  ])('goes once the PR is %s', (_what, now) => {
    prs.set(1, now);
    // Even with the approval still marked as news from when it landed.
    land(working[0]!, approved(), 2);
    const { container } = render(<TaskList tasks={working} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    expect(container.querySelector('[data-task-id="1"] .task-review')).toBeNull();
  });

  it('not in the Approved group: the group says it (#278)', () => {
    prs.set(1, approved());
    const { container } = render(<TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    expect(container.querySelector('[aria-labelledby="task-group-approved"] [data-task-id="1"]')).not.toBeNull();
    expect(container.querySelector('[data-task-id="1"] .task-review')).toBeNull();
  });

  it('says approved alone when GitHub names no reviewer', () => {
    prs.set(1, pr('APPROVED', []));
    render(<TaskList tasks={working} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    expect(screen.getByRole('img', { name: 'PR #21 approved, ready to merge' })).toBeTruthy();
  });
});

describe('TaskList: an unseen change request (#180)', () => {
  it('marks changes requested with ✎ Changes', () => {
    render(<TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    land(tasks[0]!, pr('CHANGES_REQUESTED', [{ login: 'carol', state: 'CHANGES_REQUESTED' }]), 2);
    const mark = screen.getByRole('img', { name: 'Changes requested on PR #21 by carol, not seen yet' });
    expect(mark.textContent).toBe('✎ Changes');
  });

  it('never on the selected row, nor for Awaiting Review; opening the task clears it', () => {
    const changes = pr('CHANGES_REQUESTED', [{ login: 'carol', state: 'CHANGES_REQUESTED' }]);
    const { container, rerender } = render(
      <TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />,
    );
    land(tasks[1]!, changes, 2);
    // A reviewer asked, nobody answered yet: still the default state.
    land(tasks[0]!, pr('REVIEW_REQUIRED', [{ login: 'bot', state: 'COMMENTED' }]), 2);
    expect(container.querySelector('.task-review')).toBeNull();

    land(tasks[0]!, changes, 2);
    expect(container.querySelector('[data-task-id="1"] .task-review')).not.toBeNull();
    act(() => rn.clearReviewMark(1));
    rerender(<TaskList tasks={tasks} selectedId={1} onSelect={() => {}} onNew={() => {}} />);
    expect(container.querySelector('.task-review')).toBeNull();
  });
});

describe('TaskList: conflicts GitHub reports (#236)', () => {
  const conflicting = (o: { decision?: string; state?: string; isDraft?: boolean } = {}) =>
    parsePrView(
      JSON.stringify({
        number: 21,
        state: o.state ?? 'OPEN',
        isDraft: o.isDraft ?? false,
        headRefName: 'b',
        baseRefName: 'main',
        reviewDecision: o.decision ?? 'APPROVED',
        latestReviews: [{ author: { login: 'alice' }, state: 'APPROVED', submittedAt: 't1' }],
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
      }),
    ) as PrStatus;

  it('marks ⚠ Conflicts, outranking Approved, on the selected row too', () => {
    prs.set(1, conflicting());
    const { container } = render(<TaskList tasks={tasks} selectedId={1} onSelect={() => {}} onNew={() => {}} />);
    const mark = screen.getByRole('img', { name: 'PR #21 has conflicts with main' });
    expect(mark.textContent).toBe('⚠ Conflicts');
    expect(mark.getAttribute('data-outcome')).toBe('conflicts');
    expect(container.querySelector('[data-task-id="1"] [data-outcome="approved"]')).toBeNull();
    // A mark, never a button: the actions are the task bar's.
    expect(container.querySelector('[data-task-id="1"] .task-meta-tail button')).toBeNull();
  });

  it('on a draft or an unapproved PR as well', () => {
    prs.set(1, conflicting({ isDraft: true, decision: 'REVIEW_REQUIRED' }));
    render(<TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    expect(screen.getByRole('img', { name: 'PR #21 has conflicts with main' })).toBeTruthy();
  });

  it('an unseen change request still shows beside it', () => {
    prs.set(1, conflicting({ decision: 'CHANGES_REQUESTED' }));
    const { container } = render(<TaskList tasks={working} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    land(working[0]!, pr('CHANGES_REQUESTED', [{ login: 'carol', state: 'CHANGES_REQUESTED' }]), 2);
    const marks = [...container.querySelectorAll('[data-task-id="1"] .task-review')].map((m) => m.getAttribute('data-outcome'));
    expect(marks).toEqual(['conflicts', 'changes-requested']);
  });

  it('in In Review the chip says Changes, once (#278)', () => {
    prs.set(1, conflicting({ decision: 'CHANGES_REQUESTED' }));
    const { container } = render(<TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    land(tasks[0]!, pr('CHANGES_REQUESTED', [{ login: 'carol', state: 'CHANGES_REQUESTED' }]), 2);
    expect(container.querySelector('[aria-labelledby="task-group-team"] [data-task-id="1"]')).not.toBeNull();
    const marks = [...container.querySelectorAll('[data-task-id="1"] .task-review')].map((m) => m.getAttribute('data-outcome'));
    expect(marks).toEqual(['conflicts']);
    expect(container.querySelector('[data-task-id="1"] .task-threads')?.textContent).toBe('Changes Requested');
  });

  it('gone once merged or closed', () => {
    prs.set(1, conflicting({ state: 'MERGED' }));
    prs.set(2, conflicting({ state: 'CLOSED' }));
    const { container } = render(<TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    expect(container.querySelector('[data-outcome="conflicts"]')).toBeNull();
  });
});
