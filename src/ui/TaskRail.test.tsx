/**
 * @vitest-environment jsdom
 *
 * The task list collapsed to a rail (#266): one filled count circle per
 * colour with tasks (#278: Your Review and Team Review count two groups
 * each), the selected task's circle ringed, a pulse when Needs You or Ready
 * to Review goes up (#276), and a circle's popover listing its rows --
 * opened, walked, chosen from and closed the ways a person does it. The ‹ / ›
 * toggles never move the selection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

beforeEach(() => {
  prs.clear();
  prExtra.clear();
  prs.set(3, 'open');
  setWorkProbeForTests(async () => false);
});
afterEach(cleanup);

const base = {
  projectId: 1, repoPath: '/r/app', sessionId: null, createdBranch: false, baseBranch: 'main',
  ownsWorktree: true, kind: 'work', status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: 1_000, summary: null, reviewUrl: null,
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
  it('draws one circle per colour with tasks, in the list’s order, with its count; Archived never', () => {
    renderRail();
    expect(circles().map((c) => [c.dataset.group, c.textContent])).toEqual([
      ['blocked', '1'],
      ['active', '1'],
      ['yours', '1'],
      ['quiet', '3'],
      ['done', '1'],
    ]);
    // Nothing in the team's review, so no circle.
    expect(document.querySelector('[data-group="team"]')).toBeNull();
    expect(document.querySelector('[data-group="archived"]')).toBeNull();
  });

  it('paints each circle its colour (#278); no second shape', () => {
    renderRail();
    expect(Object.fromEntries(circles().map((c) => [c.dataset.group, c.dataset.hue]))).toEqual({
      blocked: 'blocked',
      active: 'running',
      yours: 'review',
      quiet: 'idle',
      done: 'done',
    });
    expect(circles().some((c) => c.hasAttribute('data-fill'))).toBe(false);
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
    expect(pop.querySelector('.rail-pop-head .group-pie')?.getAttribute('data-hue')).toBe('idle');
    // One group: no sub-headers, and rows carry no icon (#278).
    expect(pop.querySelector('.rail-pop-sub')).toBeNull();
    expect(pop.querySelector('.task-row .status-dot, .task-row .group-pie')).toBeNull();
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
    expect(document.activeElement).toBe(circle(/^Your Review/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(running);
  });
});

describe('the pulse on a rise (#276)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const props = { signals, selectedId: 5, onSelect: () => {}, onNew: () => {}, onCollapsedChange: () => {}, collapsed: true };
  const pulseOf = (group: string) => document.querySelector(`.rail-circle[data-group="${group}"]`)?.getAttribute('data-pulse') ?? null;
  const pulsing = () => circles().filter((c) => c.hasAttribute('data-pulse')).map((c) => c.dataset.group);
  // Task 4 (Idle) now needs you: Needs You 1 -> 2.
  const moreBlocked = tasks.map((t) => (t.id === 4 ? { ...t, status: 'blocked' as const } : t));
  // A second open PR with an unseen finish: Ready to Review 1 -> 2.
  const moreReview = [...tasks, row(10, 'ABC-1300 Second PR')];
  const reviewSignals = new Map([...signals, [10, { agents: 0, question: false, finishedAt: 2_000 }]]);

  it('pulses nothing on the first render', () => {
    render(<TaskList tasks={tasks} {...props} />);
    expect(pulsing()).toEqual([]);
  });

  it('pulses Needs You when its count goes up, for 6s', () => {
    const { rerender } = render(<TaskList tasks={tasks} {...props} />);
    rerender(<TaskList tasks={moreBlocked} {...props} />);
    expect(pulsing()).toEqual(['blocked']);
    act(() => vi.advanceTimersByTime(5_999));
    expect(pulseOf('blocked')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(pulsing()).toEqual([]);
  });

  it('pulses Ready to Review when its count goes up', () => {
    prs.set(10, 'open');
    const { rerender } = render(<TaskList tasks={tasks} {...props} signals={reviewSignals} />);
    rerender(<TaskList tasks={moreReview} {...props} signals={reviewSignals} />);
    expect(circle(/^Your Review: Ready to Review 2, My Review 0$/)).toBeTruthy();
    expect(pulsing()).toEqual(['yours']);
  });

  it('does not pulse on a fall', () => {
    const { rerender } = render(<TaskList tasks={moreBlocked} {...props} />);
    rerender(<TaskList tasks={tasks} {...props} />);
    expect(circle(/^Needs You, 1 task$/)).toBeTruthy();
    expect(pulsing()).toEqual([]);
  });

  it('pulses no other group', () => {
    const moreRunning = tasks.map((t) => (t.id === 4 ? { ...t, status: 'running' as const } : t));
    const { rerender } = render(<TaskList tasks={tasks} {...props} />);
    rerender(<TaskList tasks={moreRunning} {...props} />);
    expect(circle(/^Running, 2 tasks$/)).toBeTruthy();
    expect(pulsing()).toEqual([]);
  });

  it('a rise during a pulse starts it over', () => {
    const evenMore = moreBlocked.map((t) => (t.id === 5 ? { ...t, status: 'blocked' as const } : t));
    const { rerender } = render(<TaskList tasks={tasks} {...props} />);
    rerender(<TaskList tasks={moreBlocked} {...props} />);
    const first = pulseOf('blocked');
    act(() => vi.advanceTimersByTime(3_000));
    rerender(<TaskList tasks={evenMore} {...props} />);
    // A new value swaps the animation's name, which restarts it.
    expect(pulseOf('blocked')).not.toBe(first);
    act(() => vi.advanceTimersByTime(3_000));
    expect(pulseOf('blocked')).not.toBeNull();
    act(() => vi.advanceTimersByTime(3_000));
    expect(pulsing()).toEqual([]);
  });

  it('does not pulse when the list collapses into the rail with a higher count', () => {
    const { rerender } = render(<TaskList tasks={tasks} {...props} collapsed={false} />);
    rerender(<TaskList tasks={moreBlocked} {...props} collapsed />);
    expect(circle(/^Needs You, 2 tasks$/)).toBeTruthy();
    expect(pulsing()).toEqual([]);
  });
});

describe('the merged circles (#278)', () => {
  const data = new Map<string, string>();
  beforeEach(async () => {
    data.clear();
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
  });

  /** Marks task `id` Reviewed in its guide: My Review. */
  async function startReview(id: number) {
    const store = await import('../guide/store');
    store.saveGuide(id, {
      diffHash: 'h', writtenAt: 1, base: 'main', groups: [{ title: 'T', summary: '', blocks: ['aaaa'] }],
      files: { 'a.ts': ['aaaa'] }, fallback: null,
    });
    act(() => store.setReviewed(id, [store.reviewedKey('a.ts', ['aaaa'])], true));
  }

  // Ready to Review 1 (3), My Review 1 (4), In Review 2 (11, 12), Awaiting Review 1 (13), Approved 1 (14).
  const team: Task[] = [
    ...tasks,
    row(11, 'ABC-1234 Three open', { lastActivityAt: 50 }),
    row(12, 'ABC-1229 Changes asked', { lastActivityAt: 40 }),
    row(13, 'ABC-1251 Nobody yet'),
    row(14, 'ABC-1220 Good to go'),
  ];
  function setPrs() {
    for (const id of [11, 12, 13, 14]) prs.set(id, 'open');
    prExtra.set(11, { reviewThreads: { total: 3, unresolved: 3 } });
    prExtra.set(12, { review: 'changes-requested', reviewThreads: { total: 1, unresolved: 1 } });
    prExtra.set(14, { review: 'approved' });
  }
  const props = { signals, selectedId: 5, onSelect: () => {}, onNew: () => {}, onCollapsedChange: () => {}, collapsed: true };

  it('one circle per colour: Your Review and Team Review each count two groups, and say both counts', async () => {
    setPrs();
    render(<TaskList tasks={team} {...props} />);
    await startReview(4);
    expect(circles().map((c) => [c.dataset.group, c.dataset.hue, c.textContent])).toEqual([
      ['blocked', 'blocked', '1'],
      ['active', 'running', '1'],
      ['yours', 'review', '2'],
      ['team', 'team', '3'],
      ['approved', 'approved', '1'],
      ['quiet', 'idle', '2'],
      ['done', 'done', '1'],
    ]);
    const yours = circle(/^Your Review/);
    expect(yours.getAttribute('aria-label')).toBe('Your Review: Ready to Review 1, My Review 1');
    expect(yours.title).toBe('Your Review: Ready to Review 1, My Review 1');
    expect(circle(/^Team Review/).getAttribute('aria-label')).toBe('Team Review: In Review 2, Awaiting Review 1');
    expect(circle(/^Approved/).getAttribute('aria-label')).toBe('Approved, 1 task');
  });

  it('its popover lists the tasks under the two groups’ names, In Review rows with their chip', () => {
    setPrs();
    render(<TaskList tasks={team} {...props} />);
    fireEvent.click(circle(/^Team Review/));
    const pop = screen.getByRole('menu', { name: 'Team Review' });
    expect(pop.querySelector('.rail-pop-head')?.textContent).toBe('Team Review· 3');
    // Two groups, each its own icon: none on the head.
    expect(pop.querySelector('.rail-pop-head .group-pie')).toBeNull();
    const sub = within(pop).getAllByRole('group');
    expect(sub.map((g) => g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent)).toEqual([
      'In Review2',
      'Awaiting Review1',
    ]);
    expect(within(sub[0]!).getAllByRole('menuitem').map((r) => r.querySelector('.task-threads')?.getAttribute('aria-label'))).toEqual([
      '3 unresolved threads',
      'Changes requested · 1 unresolved thread',
    ]);
    expect(within(sub[1]!).getAllByRole('menuitem').map((r) => r.querySelector('.task-key')?.textContent)).toEqual(['ABC-1251']);
    expect(sub[0]!.querySelector('.rail-pop-sub .group-pie')?.getAttribute('data-pie')).toBe('6');
    // ↓ walks across both groups.
    const rows = within(pop).getAllByRole('menuitem');
    expect(rows).toHaveLength(3);
    rows[1]!.focus();
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[2]);
  });

  it('shows only the groups that have tasks', () => {
    setPrs();
    render(<TaskList tasks={team} {...props} />);
    fireEvent.click(circle(/^Your Review/));
    const pop = screen.getByRole('menu', { name: 'Your Review' });
    expect([...pop.querySelectorAll('.rail-pop-sub')].map((s) => s.textContent)).toEqual(['Ready to Review1']);
  });

  describe('pulse', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const pulsing = () => circles().filter((c) => c.hasAttribute('data-pulse')).map((c) => c.dataset.group);

    it('not when only My Review rises: you started that review yourself', async () => {
      render(<TaskList tasks={team} {...props} />);
      await startReview(4);
      expect(circle(/^Your Review: Ready to Review 1, My Review 1$/)).toBeTruthy();
      expect(pulsing()).toEqual([]);
    });

    it('Needs You when failing checks put a task there', () => {
      setPrs();
      const { rerender } = render(<TaskList tasks={team} {...props} />);
      prExtra.set(13, { checks: { kind: 'failing', failing: 1, total: 1 } });
      rerender(<TaskList tasks={[...team]} {...props} />);
      expect(circle(/^Needs You, 2 tasks$/)).toBeTruthy();
      expect(pulsing()).toEqual(['blocked']);
    });

    it('never Team Review', () => {
      const { rerender } = render(<TaskList tasks={team} {...props} />);
      setPrs();
      rerender(<TaskList tasks={[...team]} {...props} />);
      expect(circle(/^Team Review/)).toBeTruthy();
      expect(pulsing()).toEqual([]);
    });
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
