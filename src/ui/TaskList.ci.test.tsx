/**
 * @vitest-environment jsdom
 *
 * The row mark for PR checks that finished unseen (#159): ✓ or ✗ with a word,
 * on the row the person sees, never on the selected one, and gone once the
 * task is opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const ci = await import('./ciNotice');
const { __setAttentionBackend } = await import('./attention');

const pr = (bucket: 'pending' | 'SUCCESS' | 'FAILURE'): PrStatus =>
  parsePrView(
    JSON.stringify({
      number: 21,
      state: 'OPEN',
      headRefName: 'b',
      headRefOid: 'a',
      statusCheckRollup: [
        bucket === 'pending'
          ? { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' }
          : { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: bucket },
      ],
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
  ci.resetCiNoticesForTests();
  __setAttentionBackend(() => {}, true, () => {});
});
afterEach(() => {
  cleanup();
  __setAttentionBackend(null);
});

function finish(task: Task, outcome: 'SUCCESS' | 'FAILURE', selectedId: number | null) {
  act(() => {
    ci.observeCi(task, pr('pending'), selectedId);
    ci.observeCi(task, pr(outcome), selectedId);
  });
}

describe('TaskList: unseen check results', () => {
  it('marks the row with ✗ Checks for a failure, and names the job in its tooltip', () => {
    const { container } = render(<TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    expect(container.querySelector('.task-ci')).toBeNull();
    finish(tasks[0]!, 'FAILURE', 2);
    const mark = screen.getByRole('img', { name: 'Checks failed on PR #21: test, not seen yet' });
    expect(mark.textContent).toBe('✗ Checks');
    expect(mark.getAttribute('data-outcome')).toBe('fail');
    expect(container.querySelector('[data-task-id="1"] .task-ci')).toBe(mark);
  });

  it('marks a pass with ✓ Checks', () => {
    render(<TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    finish(tasks[0]!, 'SUCCESS', 2);
    expect(screen.getByRole('img', { name: 'Checks passed on PR #21, not seen yet' }).textContent).toBe('✓ Checks');
  });

  it('never marks the selected row, and clears the mark when the task is opened', () => {
    const { container, rerender } = render(
      <TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />,
    );
    finish(tasks[1]!, 'FAILURE', 2);
    expect(container.querySelector('.task-ci')).toBeNull();

    finish(tasks[0]!, 'FAILURE', 2);
    expect(container.querySelector('[data-task-id="1"] .task-ci')).not.toBeNull();
    // Opening it: App's select, or useCiNotices on any selection change.
    act(() => ci.clearCiMark(1));
    rerender(<TaskList tasks={tasks} selectedId={1} onSelect={() => {}} onNew={() => {}} />);
    expect(container.querySelector('.task-ci')).toBeNull();
  });
});
