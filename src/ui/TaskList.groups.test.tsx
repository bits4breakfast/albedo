/**
 * @vitest-environment jsdom
 *
 * The task list's groups (#90, #278): Needs You, Running, Ready to Review,
 * My Review, In Review, Awaiting Review, Approved, Idle, Done -- rendered, in
 * order, each header with its icon, rows without one -- and Mark as Done /
 * Not Done in the row menu, where a person reaches them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../types';
import type { PrState, PrStatus } from '../gh/prStatus';
import type { TaskSignals } from './useTasks';

const prs = vi.hoisted(() => new Map<number, PrState>());
const prExtra = vi.hoisted(() => new Map<number, Partial<PrStatus>>());
vi.mock('../gh/prStore', () => ({
  getPrStatus: (id: number): PrStatus | null => {
    const state = prs.get(id);
    return state
      ? { number: id, url: 'u', title: 'p', state, headRefName: 'b', baseRefName: 'main', headSha: '', mergedAt: null, review: null, checks: { kind: 'none' }, lines: [], ...prExtra.get(id) }
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
  prExtra.clear();
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
  ownsWorktree: true, kind: 'work', status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: 1_000, summary: null,
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

  it('draws the icon on each group header, and none on a row (#278)', async () => {
    const { container } = await renderList();
    expect(container.querySelectorAll('.task-row .status-dot, .task-row .group-pie, .task-dot-cell')).toHaveLength(0);
    const pie = (title: string) =>
      [...container.querySelectorAll('.group-label')].find((l) => l.textContent?.startsWith(title))?.querySelector('.group-pie');
    expect(pie('Needs You')?.getAttribute('data-pie')).toBe('full');
    expect(pie('Running')?.getAttribute('data-pie')).toBe('2');
    expect(pie('Ready to Review')?.getAttribute('data-pie')).toBe('4');
    expect(pie('Ready to Review')?.getAttribute('data-hue')).toBe('review');
    expect(pie('Idle')?.getAttribute('data-pie')).toBe('0');
    expect(pie('Done')?.getAttribute('data-pie')).toBe('check');
    expect(pie('Done')?.querySelector('.group-pie-check')).not.toBeNull();
    expect(pie('Needs You')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.group-label[data-tone="review"]')).not.toBeNull();
  });

  it('each group names its rows for assistive tech: a row carries no icon to say it (#278)', async () => {
    await renderList();
    const group = screen.getByRole('group', { name: /^Ready to Review/ });
    expect([...group.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-task-id'))).toEqual(['7', '3']);
    expect(screen.getByRole('group', { name: /^Needs You/ }).querySelector('[data-task-id="1"]')).not.toBeNull();
  });

  it('separates the groups with a hairline above each header but the first (#278)', async () => {
    const { container } = await renderList();
    const sections = [...container.querySelectorAll('.tasklist-scroll > .task-group')];
    expect(sections.length).toBe(5);
    // The rule is `.task-group + .task-group > .group-label` (tasklist.css): every
    // section is a sibling of the one before, the first of none.
    expect(sections[0]!.previousElementSibling?.classList.contains('task-group') ?? false).toBe(false);
    for (const s of sections.slice(1)) expect(s.previousElementSibling?.classList.contains('task-group')).toBe(true);
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

describe('My Review (#219, #278), rendered', () => {
  it('a task with a Reviewed mark in its guide gets its own group', async () => {
    const data = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
      },
    });
    const store = await import('../guide/store');
    store.resetGuideStoreForTests();
    store.saveGuide(4, {
      diffHash: 'h', writtenAt: 1, base: 'main', groups: [{ title: 'T', summary: '', blocks: ['aaaa'] }],
      files: { 'a.ts': ['aaaa'] }, fallback: null,
    });
    const { container } = await renderList();
    expect(groups(container).map(([g]) => g)).not.toContain('My Review');
    // The first Reviewed tick moves it, with no reload.
    act(() => store.setReviewed(4, [store.reviewedKey('a.ts', ['aaaa'])], true));
    expect(groups(container)).toEqual([
      ['Needs You', ['1']],
      ['Running', ['2']],
      ['Ready to Review', ['7', '3']],
      ['My Review', ['4']],
      ['Idle', ['8']],
      ['Done', ['6', '5']],
    ]);
    expect(container.querySelector('#task-group-mine .group-pie')?.getAttribute('data-hue')).toBe('review');
  });
});

describe('the PR groups (#278), rendered', () => {
  const seen = { seenAt: 5_000 };
  const prTasks: Task[] = [
    row(11, 'ABC-1201 Nobody looked yet', seen),
    row(12, 'ABC-1202 Three threads open', seen),
    row(13, 'ABC-1203 Changes and one thread', seen),
    row(14, 'ABC-1204 Changes, no thread', seen),
    row(15, 'ABC-1205 Approved', seen),
    row(16, 'ABC-1206 Approved with a thread open', seen),
    row(17, 'ABC-1207 Checks failed', seen),
    row(18, 'ABC-1208 Draft', seen),
    row(19, 'ABC-1209 All threads resolved', seen),
  ];

  async function renderPrs() {
    for (const t of prTasks) prs.set(t.id, 'open');
    prs.set(18, 'draft');
    prExtra.set(12, { reviewThreads: { total: 3, unresolved: 3 } });
    prExtra.set(13, { review: 'changes-requested', reviewThreads: { total: 2, unresolved: 1 } });
    prExtra.set(14, { review: 'changes-requested', reviewThreads: { total: 0, unresolved: 0 } });
    prExtra.set(15, { review: 'approved', reviews: [{ author: 'alice', state: 'approved', submittedAt: '2026-11-06T09:00:00Z' }] });
    prExtra.set(16, { review: 'approved', reviewThreads: { total: 2, unresolved: 1 } });
    prExtra.set(17, { checks: { kind: 'failing', failing: 1, total: 2 } });
    prExtra.set(19, { reviewThreads: { total: 2, unresolved: 0 } });
    const view = render(<TaskList tasks={prTasks} selectedId={null} onSelect={() => {}} onNew={() => {}} />);
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    return view;
  }
  const meta = (c: HTMLElement, id: number) => c.querySelector(`[data-task-id="${id}"] .task-meta-tail`);

  it('sorts open PRs by where the review stands', async () => {
    const { container } = await renderPrs();
    expect(groups(container)).toEqual([
      ['Needs You', ['17']],
      ['In Review', ['19', '14', '13', '12']],
      ['Awaiting Review', ['11']],
      ['Approved', ['16', '15']],
      ['Idle', ['18']],
    ]);
  });

  it('In Review rows show the unresolved threads, and a change request', async () => {
    const { container } = await renderPrs();
    const chip = (id: number) => meta(container, id)?.querySelector('.task-threads')?.textContent ?? null;
    expect(chip(12)).toBe('3 unresolved');
    expect(chip(13)).toBe('Changes · 1 unresolved');
    expect(chip(14)).toBe('Changes Requested');
    // Nothing open, nothing to count: the group says In Review.
    expect(chip(19)).toBeNull();
    expect(chip(11)).toBeNull();
  });

  it('Approved rows carry no Approved mark: the group says it; an open thread still shows', async () => {
    const { container } = await renderPrs();
    expect(meta(container, 15)?.textContent).not.toMatch(/Approved/);
    expect(meta(container, 16)?.querySelector('.task-threads')?.textContent).toBe('1 unresolved');
  });

  it('a task in Needs You for its checks says so on its row', async () => {
    const { container } = await renderPrs();
    const mark = meta(container, 17)?.querySelector('.task-checks-failing');
    expect(mark?.textContent).toBe('✗ Checks');
    expect(mark?.getAttribute('aria-label')).toBe('1 of 2 checks failing on PR #17');
    // A row with a prompt waiting is untouched: it is in Needs You for that.
    expect(container.querySelectorAll('.task-checks-failing')).toHaveLength(1);
  });

  it('the headers fill as the work moves along', async () => {
    const { container } = await renderPrs();
    const pie = (key: string) => container.querySelector(`#task-group-${key} .group-pie`);
    expect(pie('team')?.getAttribute('data-pie')).toBe('6');
    expect(pie('team')?.getAttribute('data-hue')).toBe('team');
    expect(pie('awaiting')?.getAttribute('data-pie')).toBe('5');
    expect(pie('awaiting')?.getAttribute('data-hue')).toBe('team');
    expect(pie('approved')?.getAttribute('data-pie')).toBe('7');
    expect(pie('approved')?.getAttribute('data-hue')).toBe('approved');
  });
});
