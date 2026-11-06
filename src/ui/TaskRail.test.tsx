/**
 * @vitest-environment jsdom
 *
 * The task list collapsed to a rail (#266): one count circle per non-empty
 * group, filled or outlined by group, the selected task's group ringed, and a
 * circle's popover listing that group's rows -- opened, walked, chosen from
 * and closed the ways a person does it. The ‹ / › toggles never move the
 * selection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

beforeEach(() => {
  prs.clear();
  prs.set(3, 'open');
  setWorkProbeForTests(async () => false);
});
afterEach(cleanup);

const base = {
  projectId: 1, repoPath: '/r/app', sessionId: null, createdBranch: false, baseBranch: 'main',
  ownsWorktree: true, kind: 'work', status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: 1_000, summary: null,
} as const;
const row = (id: number, title: string, over: Partial<Task> = {}): Task => ({
  ...base, id, title, branch: `b${id}`, worktreePath: `/w/${id}`, ...over,
});

// Needs You 1, Running 1, Ready to Review 1, Idle 3, Done 1; Archived 1 (never a circle).
const tasks: Task[] = [
  row(1, 'ABC-1290 Asks to run tests', { status: 'blocked' }),
  row(2, 'image-import', { status: 'running' }),
  row(3, 'ABC-1234 Open PR, unseen finish'),
  row(4, 'filter-by-tag', { lastActivityAt: 30 }),
  row(5, 'ABC-1201', { lastActivityAt: 20 }),
  row(6, 'guest-messages', { lastActivityAt: 10 }),
  row(7, 'Marked done', { status: 'done' }),
  row(9, 'Archived one', { status: 'archived' }),
];
const signals = new Map<number, TaskSignals>([
  [3, { agents: 0, question: false, finishedAt: 2_000 }],
  [5, { agents: 2, question: false, finishedAt: null }],
]);

function renderRail(over: { selectedId?: number | null; onSelect?: (id: number) => void; onCollapsedChange?: (c: boolean) => void } = {}) {
  const onSelect = over.onSelect ?? vi.fn();
  const onCollapsedChange = over.onCollapsedChange ?? vi.fn();
  const view = render(
    <TaskList
      tasks={tasks}
      signals={signals}
      selectedId={over.selectedId === undefined ? 5 : over.selectedId}
      onSelect={onSelect}
      onNew={() => {}}
      collapsed
      onCollapsedChange={onCollapsedChange}
    />,
  );
  return { ...view, onSelect, onCollapsedChange };
}

const circles = () => [...document.querySelectorAll<HTMLButtonElement>('.rail-circle')];
const circle = (name: RegExp) => screen.getByRole('button', { name });

describe('the rail (#266)', () => {
  it('draws one circle per non-empty group, in the list’s order, with its count; Archived never', () => {
    renderRail();
    expect(circles().map((c) => [c.dataset.group, c.textContent])).toEqual([
      ['blocked', '1'],
      ['active', '1'],
      ['review', '1'],
      ['quiet', '3'],
      ['done', '1'],
    ]);
    // In Review has no task, so no circle.
    expect(document.querySelector('[data-group="reviewing"]')).toBeNull();
    expect(document.querySelector('[data-group="archived"]')).toBeNull();
  });

  it('fills every group, rings Ready to Review, dots Done (#276)', () => {
    renderRail();
    expect(Object.fromEntries(circles().map((c) => [c.dataset.group, c.dataset.fill]))).toEqual({
      blocked: 'solid',
      active: 'solid',
      review: 'ringed',
      quiet: 'solid',
      done: 'dotted',
    });
  });

  it('names each circle by its group and count, as tooltip and accessible name', () => {
    renderRail();
    const idle = circle(/^Idle, 3 tasks$/);
    expect(idle.title).toBe('Idle, 3 tasks');
    expect(circle(/^Needs You, 1 task$/).title).toBe('Needs You, 1 task');
    expect(idle.tagName).toBe('BUTTON');
    expect(idle.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('rings the selected task’s group, and only that one', () => {
    renderRail({ selectedId: 5 });
    expect(circles().filter((c) => c.getAttribute('aria-current') === 'true').map((c) => c.dataset.group)).toEqual(['quiet']);
    cleanup();
    renderRail({ selectedId: 1 });
    expect(circles().filter((c) => c.getAttribute('aria-current') === 'true').map((c) => c.dataset.group)).toEqual(['blocked']);
    cleanup();
    renderRail({ selectedId: null });
    expect(circles().some((c) => c.hasAttribute('aria-current'))).toBe(false);
  });

  it('keeps New Task as ＋, and › expands without touching the selection', () => {
    const { onSelect, onCollapsedChange } = renderRail();
    expect(screen.getByRole('button', { name: 'New Task' }).title).toBe('New task (⌘N)');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Task List' }));
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('a circle’s popover (#266)', () => {
  it('opens on a click with the group’s head and rows, as the list draws them', () => {
    renderRail();
    const idle = circle(/^Idle/);
    fireEvent.click(idle);
    const pop = screen.getByRole('menu', { name: 'Idle' });
    expect(idle.getAttribute('aria-expanded')).toBe('true');
    expect(pop.querySelector('.rail-pop-head')?.textContent).toBe('Idle· 3');
    expect(pop.querySelector('.rail-pop-head .status-dot')?.getAttribute('data-status')).toBe('idle');
    const rows = within(pop).getAllByRole('menuitem');
    // The list's order within the group: most recent first.
    expect(rows.map((r) => r.querySelector('.task-title')?.textContent)).toEqual(['filter-by-tag', 'ABC-1201', 'guest-messages']);
    // The list's issue-key chip and its marks: two agents on ABC-1201.
    expect(rows[1]!.querySelector('.task-key')?.textContent).toBe('ABC-1201');
    expect(rows[1]!.querySelector('.task-agents')?.textContent).toBe('·2');
    expect(rows[0]!.querySelector('.task-age')).not.toBeNull();
  });

  it('gives the keyboard to the selected task’s row; ↑/↓ walk the rows', () => {
    renderRail({ selectedId: 5 });
    fireEvent.click(circle(/^Idle/));
    const rows = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2]!, { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
  });

  it('rows are buttons, so Return chooses the focused one', () => {
    renderRail();
    fireEvent.click(circle(/^Idle/));
    for (const r of within(screen.getByRole('menu')).getAllByRole('menuitem')) expect(r.tagName).toBe('BUTTON');
  });

  it('a click on a row selects that task and closes', () => {
    const { onSelect } = renderRail();
    fireEvent.click(circle(/^Idle/));
    fireEvent.click(within(screen.getByRole('menu')).getByText('guest-messages'));
    expect(onSelect).toHaveBeenCalledWith(6);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape closes it, is marked handled (#267), and puts focus back on the circle', () => {
    renderRail();
    const idle = circle(/^Idle/);
    fireEvent.click(idle);
    const row = within(screen.getByRole('menu')).getAllByRole('menuitem')[0]!;
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      row.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(idle);
    expect(idle.getAttribute('aria-expanded')).toBe('false');
  });

  it('a press outside closes it; a press on another circle switches group', () => {
    const { onSelect } = renderRail();
    fireEvent.click(circle(/^Idle/));
    fireEvent.pointerDown(circle(/^Running/));
    expect(screen.getByRole('menu', { name: 'Idle' })).toBeTruthy();
    fireEvent.click(circle(/^Running/));
    expect(screen.getByRole('menu', { name: 'Running' })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a second click on its circle closes it', () => {
    renderRail();
    fireEvent.click(circle(/^Idle/));
    fireEvent.click(circle(/^Idle/));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Tab closes it back to the circle', () => {
    renderRail();
    const idle = circle(/^Idle/);
    fireEvent.click(idle);
    fireEvent.keyDown(within(screen.getByRole('menu')).getAllByRole('menuitem')[0]!, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(idle);
  });

  it('↑/↓ walk the circles', () => {
    renderRail();
    const running = circle(/^Running/);
    running.focus();
    fireEvent.keyDown(running, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(circle(/^Ready to Review/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(running);
  });
});

describe('collapsing (#266)', () => {
  it('‹ beside New Task asks to collapse, never selects, and hands focus to ›', () => {
    const onSelect = vi.fn();
    const onCollapsedChange = vi.fn();
    const props = { tasks, signals, selectedId: 5, onSelect, onNew: () => {}, onCollapsedChange };
    const { rerender } = render(<TaskList {...props} />);
    const collapse = screen.getByRole('button', { name: 'Collapse Task List' });
    expect(collapse.title).toBe('Collapse the task list (⌥⌘T)');
    fireEvent.click(collapse);
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    rerender(<TaskList {...props} collapsed />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Expand Task List' }));
    expect(onSelect).not.toHaveBeenCalled();
    // And back: the list again, the same row selected.
    fireEvent.click(screen.getByRole('button', { name: 'Expand Task List' }));
    rerender(<TaskList {...props} collapsed={false} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Collapse Task List' }));
    expect(document.querySelector('[data-task-id="5"]')?.getAttribute('data-selected')).toBe('true');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('offers no ‹ when nobody handles it', () => {
    render(<TaskList tasks={tasks} selectedId={null} onSelect={() => {}} onNew={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Collapse Task List' })).toBeNull();
  });

  it('keeps the list’s shortcuts while collapsed: ⌘2 is still the second task', () => {
    const { onSelect } = renderRail();
    fireEvent.keyDown(window, { key: '2', code: 'Digit2', metaKey: true });
    expect(onSelect).toHaveBeenCalledWith(2);
  });
});
