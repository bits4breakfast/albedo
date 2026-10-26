/**
 * @vitest-environment jsdom
 *
 * The "Draft" mark on a task row (#55): there for a task with an unsent
 * message in its composer, so a forgotten one can be found -- and not on the
 * selected row, whose draft is already in the box below.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Task } from '../types';

vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));

// jsdom has no layout; the list scrolls the selected row into view.
Element.prototype.scrollIntoView = () => {};

const { default: TaskList } = await import('./TaskList');
const { __resetDrafts, dropDraft, saveDraft } = await import('./transcript/drafts');

afterEach(() => {
  cleanup();
  __resetDrafts();
});

const base = {
  projectId: 1, repoPath: '/r/app', sessionId: null, createdBranch: false, baseBranch: 'main',
  status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: null, ownsWorktree: true, kind: 'work',
} as const;
const a: Task = { ...base, id: 1, title: 'Fix login', branch: 'fix-login', worktreePath: '/w/1' };
const b: Task = { ...base, id: 2, title: 'Add search', branch: 'add-search', worktreePath: '/w/2' };

const marked = (container: HTMLElement) =>
  [...container.querySelectorAll('.task-draft')].map((el) => el.closest('[data-task-id]')?.getAttribute('data-task-id'));

describe('the Draft mark', () => {
  it('shows on a row with a draft, never on the selected one, and follows the store', () => {
    saveDraft(1, 'unsent', new Map());
    saveDraft(2, 'also unsent', new Map());
    const { container } = render(<TaskList tasks={[a, b]} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    expect(marked(container)).toEqual(['1']);
    expect(container.querySelector('.task-draft')?.textContent).toBe('Draft');

    act(() => dropDraft(1));
    expect(marked(container)).toEqual([]);
  });
});
