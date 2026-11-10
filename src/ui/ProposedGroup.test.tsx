/**
 * @vitest-environment jsdom
 *
 * The Proposed group (#332), through what a person does: a request for a new
 * session shows as a row at the top of Building, above Needs You; a click on
 * the row opens a popover beside it with the reason and the brief, and Esc,
 * a click elsewhere or the row again close it; Approve… and Deny are on the
 * row only; a denied request leaves the list. A proposal is not a task: no
 * option role, never selected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { Task } from '../types';
import type { SessionRequest } from './requestQueue';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));

Element.prototype.scrollIntoView = () => {};

const { default: TaskList } = await import('./TaskList');
const { setWorkProbeForTests } = await import('../git/reviewWork');
const q = await import('./requestQueue');
const { proposalsInScope } = await import('./proposals');
const { useFocusAreaCycle } = await import('./focusAreas');

let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  q.__resetRequests();
  setWorkProbeForTests(async () => false);
});
afterEach(cleanup);

const NOW = Date.now();
const base = {
  projectId: 1, repoPath: '/r/app', sessionId: null, createdBranch: false, baseBranch: 'main',
  ownsWorktree: true, kind: 'work', status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: 1_000, summary: null, reviewUrl: null,
} as const;
const row = (id: number, title: string, over: Partial<Task> = {}): Task => ({
  ...base, id, title, branch: `b${id}`, worktreePath: `/w/${id}`, ...over,
});
const tasks: Task[] = [row(1, 'Asks to run tests', { status: 'blocked' }), row(2, 'Video player rewrite')];

const ask = (id: string, over: Partial<SessionRequest> = {}): SessionRequest => ({
  id,
  taskId: 2,
  at: NOW - 3 * 60_000,
  tool: 'request_session',
  title: 'Videos stuck at 0:00',
  prompt: 'Playback never starts on the second video.\nThe player logs nothing.',
  reason: 'A separate bug, found while testing this one.',
  project: 'video-player',
  branch: 'fix/stuck-at-zero',
  ...over,
});

/** The list as App wires it: the queue, scoped (no tab bar here), Deny dropping the request. */
function Harness({ onApprove, collapsed = false }: { onApprove: (r: SessionRequest) => void; collapsed?: boolean }) {
  const items = q.useRequests();
  return (
    <TaskList
      tasks={tasks}
      selectedId={null}
      onSelect={() => {}}
      onNew={() => {}}
      proposals={proposalsInScope(items, null, tasks, [])}
      titleOf={(id) => tasks.find((t) => t.id === id)?.title ?? null}
      onApproveProposal={onApprove}
      onDenyProposal={q.dismissRequest}
      collapsed={collapsed}
      onCollapsedChange={() => {}}
    />
  );
}

function setup(reqs: SessionRequest[] = [ask('s1')], collapsed = false) {
  for (const r of reqs) q.receiveRequest(r, { title: 'Video player rewrite', archived: false });
  const onApprove = vi.fn();
  const view = render(<Harness onApprove={onApprove} collapsed={collapsed} />);
  return { ...view, onApprove };
}

const group = () => screen.getByRole('group', { name: /^Proposed/ });
const trigger = (name = 'Videos stuck at 0:00') => screen.getByRole('button', { name });

describe('the Proposed group (#332)', () => {
  it('shows a request at the top of Building, above Needs You, with who asked and when', () => {
    const { container } = setup();
    const labels = [...container.querySelectorAll('.group-label')].map((l) => l.textContent);
    expect(labels[0]).toBe('Proposed1');
    expect(labels[1]).toContain('Needs You');
    const g = group();
    expect(g.textContent).toContain('Videos stuck at 0:00');
    expect(g.textContent).toContain('from Video player rewrite · 3m');
    // Not a task: no option, no selection, ⌘1 is still the first task.
    expect(within(g).queryByRole('option')).toBeNull();
    expect(g.querySelector('[data-task-id]')).toBeNull();
    expect(g.querySelector('.proposed-ring')).not.toBeNull();
  });

  it('lists newest first, and counts them in the header', () => {
    setup([ask('a', { title: 'Ticket triage', at: NOW - 60_000 }), ask('b', { title: 'Newer one', at: NOW - 1_000 })]);
    const titles = [...group().querySelectorAll('.proposal-title')].map((b) => b.textContent);
    expect(titles).toEqual(['Newer one', 'Ticket triage']);
    expect(group().querySelector('.group-count')?.textContent).toBe('2');
  });

  it('a click on the row opens a popover beside it with the reason and the brief, and no buttons', () => {
    setup();
    const t = trigger();
    expect(t.getAttribute('aria-haspopup')).toBe('dialog');
    expect(t.getAttribute('aria-expanded')).toBe('false');
    // On the row's "from" line, not the title: the whole row opens it.
    fireEvent.click(group().querySelector('.proposal-from')!);
    const pop = screen.getByRole('dialog', { name: 'Videos stuck at 0:00' });
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(pop.textContent).toContain('from Video player rewrite');
    expect(pop.textContent).toContain('A separate bug, found while testing this one.');
    expect(pop.textContent).toContain('Playback never starts on the second video.');
    expect(pop.textContent).toContain('Project: video-player');
    expect(pop.textContent).toContain('Branch: fix/stuck-at-zero');
    expect(within(pop).queryAllByRole('button')).toEqual([]);
    expect(document.activeElement).toBe(pop);
  });

  it('closes on the row again, on Esc and on a click elsewhere; Esc and the row give focus back to the row', () => {
    setup();
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());

    fireEvent.click(trigger());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());

    fireEvent.click(trigger());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Approve… hands the request on, as the header used to; nothing leaves until the task is created', () => {
    const { onApprove } = setup();
    fireEvent.click(trigger());
    fireEvent.click(within(group()).getByRole('button', { name: 'Approve…' }));
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', title: 'Videos stuck at 0:00' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('group', { name: /^Proposed/ })).not.toBeNull();
    // New Task's Create resolves it (resolveRequest): then it goes.
    act(() => q.resolveRequest('s1'));
    expect(screen.queryByRole('group', { name: /^Proposed/ })).toBeNull();
  });

  it('Deny removes the row, and the group with its last one', () => {
    setup([ask('s1'), ask('s2', { title: 'Ticket triage' })]);
    const rowOf = (title: string) => trigger(title).closest('.proposal-row') as HTMLElement;
    fireEvent.click(within(rowOf('Ticket triage')).getByRole('button', { name: 'Deny' }));
    expect(screen.queryByRole('button', { name: 'Ticket triage' })).toBeNull();
    expect(q.pendingRequests().map((r) => r.id)).toEqual(['s1']);
    fireEvent.click(within(rowOf('Videos stuck at 0:00')).getByRole('button', { name: 'Deny' }));
    expect(screen.queryByRole('group', { name: /^Proposed/ })).toBeNull();
  });

  it('a request kept from before a restart shows the same way', () => {
    q.receiveRequest(ask('kept'), { title: 'Video player rewrite', archived: false });
    q.__resetRequests(); // the app restarts: the queue is read back from storage
    render(<Harness onApprove={() => {}} />);
    expect(group().textContent).toContain('Videos stuck at 0:00');
  });

  it('Tab walks from the list into each row’s title, Deny and Approve…; Enter opens the popover', () => {
    renderHook(() => useFocusAreaCycle());
    setup([ask('s1'), ask('s2', { title: 'Ticket triage', at: NOW - 3_600_000 })]);
    const list = document.querySelector<HTMLElement>('.tasklist')!;
    list.focus();
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      fireEvent.keyDown(document.activeElement!, { key: 'Tab', code: 'Tab' });
      order.push(document.activeElement?.textContent ?? '');
    }
    expect(order).toEqual(['Videos stuck at 0:00', 'Deny', 'Approve…', 'Ticket triage', 'Deny', 'Approve…']);
    // A button's Enter is its click.
    fireEvent.click(trigger('Ticket triage'));
    expect(screen.getByRole('dialog', { name: 'Ticket triage' })).not.toBeNull();
  });

  it('the list is no Tab stop of its own without proposals', () => {
    render(<Harness onApprove={() => {}} />);
    expect(document.querySelector('.tasklist')?.hasAttribute('data-focus-stop')).toBe(false);
  });

  it('no group when nothing is proposed', () => {
    render(<Harness onApprove={() => {}} />);
    expect(screen.queryByRole('group', { name: /^Proposed/ })).toBeNull();
  });
});

describe('the rail’s Proposed circle (#332)', () => {
  it('counts the proposals in a dashed circle above the groups, and expands the list', () => {
    const onCollapsedChange = vi.fn();
    for (const r of [ask('a'), ask('b')]) q.receiveRequest(r, { title: 'Video player rewrite', archived: false });
    render(
      <TaskList
        tasks={tasks}
        selectedId={null}
        onSelect={() => {}}
        onNew={() => {}}
        proposals={proposalsInScope(q.pendingRequests(), null, tasks, [])}
        collapsed
        onCollapsedChange={onCollapsedChange}
      />,
    );
    const circles = [...document.querySelectorAll<HTMLButtonElement>('.rail-circle')];
    expect(circles.map((c) => [c.dataset.group, c.textContent])).toEqual([
      ['proposed', '2'],
      ['blocked', '1'],
      ['quiet', '1'],
    ]);
    const proposed = screen.getByRole('button', { name: 'Proposed, 2 new tasks to approve' });
    expect(proposed.dataset.hue).toBe('proposed');
    fireEvent.click(proposed);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it('has no circle when nothing is proposed', () => {
    render(
      <TaskList tasks={tasks} selectedId={null} onSelect={() => {}} onNew={() => {}} collapsed onCollapsedChange={() => {}} />,
    );
    expect(document.querySelector('[data-group="proposed"]')).toBeNull();
  });
});
