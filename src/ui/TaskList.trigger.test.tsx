/**
 * @vitest-environment jsdom
 *
 * A trigger's card waiting (#448): the task moves to Needs You with a word on
 * its row ("PR merged · draft ready"), the way a waiting mockup does, and
 * back once the card is gone. Memoised rows redraw for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Task } from '../types';

vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));

Element.prototype.scrollIntoView = () => {};

const { default: TaskList } = await import('./TaskList');
const { __resetTriggerStore, addTriggerCard, resolveTriggerCard } = await import('../triggers/store');
const { cardFor } = await import('../triggers/facts');

const row = (id: number, title: string): Task =>
  ({
    id, title, projectId: 1, repoPath: '/r/app', sessionId: null, createdBranch: false, baseBranch: 'main',
    ownsWorktree: true, kind: 'work', status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: 1, summary: null, branch: `b${id}`,
    worktreePath: `/w/${id}`, reviewUrl: null, apiError: null, apiErrorText: null,
  }) as Task;
const tasks = [row(1, 'checkout-retry'), row(2, 'export-refactor')];

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
  __resetTriggerStore();
});
afterEach(() => cleanup());

const card = cardFor(
  { event: 'merged', prNumber: 412, prTitle: 'Send the confirmation once per order', prUrl: 'u', mergeCommit: null },
  'draft',
  '/after-merge',
  1,
);

/** The group a row is drawn in, by its header's key. */
const groupOfRow = (container: HTMLElement, id: number) =>
  container.querySelector(`[data-task-id="${id}"]`)?.closest('.task-group')?.getAttribute('aria-labelledby') ?? null;

describe('TaskList: a trigger card waiting', () => {
  it('moves the task to Needs You with the card’s word, and back once it is gone', () => {
    const { container } = render(<TaskList tasks={tasks} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    expect(screen.queryByText('Needs You')).toBeNull();
    act(() => addTriggerCard(1, card));
    expect(screen.getByText('Needs You')).toBeTruthy();
    const word = screen.getByText('PR merged · draft ready');
    expect(word.getAttribute('data-why')).toBe('trigger');
    expect(container.querySelector('[data-task-id="1"]')!.contains(word)).toBe(true);
    expect(groupOfRow(container, 1)).toBe('task-group-blocked');
    act(() => resolveTriggerCard(1, card.id));
    expect(screen.queryByText('PR merged · draft ready')).toBeNull();
    expect(screen.queryByText('Needs You')).toBeNull();
    expect(groupOfRow(container, 1)).toBe('task-group-quiet');
  });

  it('shows on the selected row too: it is why the task is in Needs You', () => {
    render(<TaskList tasks={tasks} selectedId={1} onSelect={() => {}} onNew={() => {}} />);
    act(() => addTriggerCard(1, card));
    expect(screen.getByText('PR merged · draft ready')).toBeTruthy();
  });
});

describe('TaskList: which reason the row says', () => {
  it('a stopped-on-error label outranks the trigger word', () => {
    const errored = { ...tasks[0]!, apiError: 'overloaded', apiErrorText: 'Overloaded' } as Task;
    render(<TaskList tasks={[errored, tasks[1]!]} selectedId={2} onSelect={() => {}} onNew={() => {}} />);
    act(() => addTriggerCard(1, card));
    expect(screen.queryByText('PR merged · draft ready')).toBeNull();
    expect(document.querySelector('[data-task-id="1"] .task-why')!.getAttribute('data-why')).toBeNull();
  });
});
