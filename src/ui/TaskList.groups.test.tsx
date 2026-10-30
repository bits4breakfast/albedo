/**
 * @vitest-environment jsdom
 *
 * The task list's groups (#90): Needs You, Running, Ready to Review, Idle,
 * Done -- rendered, in order, with each row wearing its group's glyph -- and
 * Mark as Done / Not Done in the row menu, where a person reaches them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../types';
import type { PrState, PrStatus } from '../gh/prStatus';
import type { TaskSignals } from './useTasks';

const prs = vi.hoisted(() => new Map<number, PrState>());
vi.mock('../gh/prStore', () => ({
  getPrStatus: (id: number): PrStatus | null => {
    const state = prs.get(id);
    return state
      ? { number: id, url: 'u', title: 'p', state, headRefName: 'b', baseRefName: 'main', headSha: '', mergedAt: null, review: null, checks: { kind: 'none' }, lines: [] }
      : null;
  },
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));

Element.prototype.scrollIntoView = () => {};

const { default: TaskList } = await import('./TaskList');
const { setWorkProbeForTests } = await import('../git/reviewWork');

const probed: number[] = [];
beforeEach(() => {
  prs.clear();
  probed.length = 0;
  // Task 7's branch has commits; everyone else's is clean.
  setWorkProbeForTests(async (t) => {
    probed.push(t.id);
    return t.id === 7;
  });
});
afterEach(cleanup);

const base = {
  projectId: 1, repoPath: '/r/app', sessionId: null, createdBranch: false, baseBranch: 'main',
  ownsWorktree: true, kind: 'work', status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: 1_000,
} as const;
const row = (id: number, title: string, over: Partial<Task> = {}): Task => ({
  ...base, id, title, branch: `b${id}`, worktreePath: `/w/${id}`, ...over,
});

const tasks: Task[] = [
  row(1, 'Asks to run tests', { status: 'blocked' }),
  row(2, 'Working', { status: 'running' }),
  row(3, 'Open PR, unseen finish'),
  row(4, 'Seen already', { seenAt: 5_000 }),
  row(5, 'Marked done', { status: 'done' }),
  row(6, 'Merged'),
  row(7, 'Commits, unseen finish'),
  row(8, 'Clean, unseen finish'),
];
const signals = new Map<number, TaskSignals>(
  [3, 4, 7, 8].map((id) => [id, { agents: 0, question: false, finishedAt: id === 7 ? 1_500 : 2_000 }]),
);

function groups(container: HTMLElement): [string, string[]][] {
  return [...container.querySelectorAll('.group-label')].map((label) => [
    label.querySelector('span:nth-child(2)')?.textContent ?? '',
    [...(label.parentElement?.querySelectorAll('[data-task-id]') ?? [])].map((r) => r.getAttribute('data-task-id') ?? ''),
  ]);
}

async function renderList(onSetDone = vi.fn()) {
  prs.set(3, 'open');
  prs.set(6, 'merged');
  const view = render(
    <TaskList tasks={tasks} signals={signals} selectedId={null} onSelect={() => {}} onNew={() => {}} onSetDone={onSetDone} onArchive={() => {}} />,
  );
  // The git probe answers asynchronously.
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  return { ...view, onSetDone };
}

describe('task list groups', () => {
  it('groups top to bottom, Ready to Review oldest finish first', async () => {
    const { container } = await renderList();
    expect(groups(container)).toEqual([
      ['Needs You', ['1']],
      ['Running', ['2']],
      ['Ready to Review', ['7', '3']],
      ['Idle', ['8', '4']],
      ['Done', ['6', '5']],
    ]);
  });

  it('asks git only about unseen finishes the PR does not answer', async () => {
    await renderList();
    expect(probed.sort()).toEqual([7, 8]);
  });

  it("gives each row its group's glyph and word", async () => {
    const { container } = await renderList();
    const dot = (id: number) => container.querySelector(`[data-task-id="${id}"] .status-dot`);
    expect(dot(7)?.getAttribute('data-status')).toBe('review');
    expect(dot(7)?.getAttribute('aria-label')).toBe('Ready to Review');
    expect(dot(6)?.getAttribute('data-status')).toBe('done');
    expect(dot(4)?.getAttribute('data-status')).toBe('idle');
    expect(container.querySelector('.group-label[data-tone="review"]')).not.toBeNull();
  });
});

describe('Mark as Done in the row menu', () => {
  const menuFor = (title: string) => fireEvent.click(screen.getByRole('button', { name: `Actions for ${title}` }));

  it('marks a task at rest done', async () => {
    const { onSetDone } = await renderList();
    menuFor('Seen already');
    expect(screen.queryByRole('menuitem', { name: /Mark as Not Done/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Mark as Done/ }));
    expect(onSetDone).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }), true);
  });

  it('undoes a task marked done', async () => {
    const { onSetDone } = await renderList();
    menuFor('Marked done');
    expect(screen.queryByRole('menuitem', { name: /^Mark as Done/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Mark as Not Done/ }));
    expect(onSetDone).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), false);
  });

  it('offers neither on a merged PR or a running task', async () => {
    await renderList();
    for (const title of ['Merged', 'Working']) {
      menuFor(title);
      expect(screen.queryByRole('menuitem', { name: /Mark as/ })).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });
    }
  });
});
