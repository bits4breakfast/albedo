/**
 * @vitest-environment jsdom
 *
 * The memoised task row (#364). Props are passed as App passes them -- the
 * same callbacks and maps from one render to the next, and a new object only
 * for a task that changed -- so a skipped render would show here as a row
 * that did not update. Each thing a row shows is changed on its own, and the
 * row must follow; a change to one task redraws that row alone.
 *
 * The caches and stores a row reads are covered by their own files too
 * (TaskList.ci, .review, .draft, .remote, .background tests); this one adds
 * the PR cache, which those mock flat, and the list's own state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import type { Task } from '../types';
import type { ContextUsage } from '../capture';
import type { TaskSignals } from './useTasks';
import type { AttentionKind } from './attention';
import { parsePrView, type PrStatus } from '../gh/prStatus';

const h = vi.hoisted(() => ({
  prs: new Map<number, PrStatus | null>(),
  prListeners: new Set<() => void>(),
  prVersion: 0,
  /** Row renders, by task id: the context hairline is drawn once per row render. */
  rowRenders: [] as (number | undefined)[],
}));

vi.mock('../gh/prStore', () => ({
  getPrStatus: (id: number) => h.prs.get(id) ?? null,
  usePrPolling: () => {},
  usePrStatusVersion: () =>
    useSyncExternalStore(
      (cb) => {
        h.prListeners.add(cb);
        return () => void h.prListeners.delete(cb);
      },
      () => h.prVersion,
    ),
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));
vi.mock('./StatusDot', async (orig) => ({
  ...(await orig<typeof import('./StatusDot')>()),
  ContextMeter: ({ usage }: { usage?: ContextUsage | null }) => {
    h.rowRenders.push(usage === undefined ? undefined : Math.round((usage?.fraction ?? 0) * 100));
    return null;
  },
}));

Element.prototype.scrollIntoView = () => {};

const { default: TaskList } = await import('./TaskList');

const base = {
  projectId: 1, repoPath: '/r/app', createdBranch: false, baseBranch: 'main', kind: 'work',
  status: 'idle', createdAt: 1, seenAt: 1, summary: null, reviewUrl: null, apiError: null, apiErrorText: null,
  spunFromTaskId: null, ownsWorktree: true,
} as const;
const mk = (id: number, lastActivityAt: number): Task => ({
  ...base, id, title: `Task ${id}`, branch: `b${id}`, worktreePath: `/w/${id}`, sessionId: `s${id}`, lastActivityAt,
});

const openPr = (mergeable: 'MERGEABLE' | 'CONFLICTING'): PrStatus =>
  parsePrView(
    JSON.stringify({
      number: 21, state: 'OPEN', headRefName: 'b1', baseRefName: 'main', reviewDecision: 'REVIEW_REQUIRED',
      mergeable, mergeStateStatus: mergeable === 'CONFLICTING' ? 'DIRTY' : 'CLEAN',
    }),
  ) as PrStatus;

const usage = (fraction: number): ContextUsage => ({
  used: Math.round(fraction * 200_000), limit: 200_000, fraction, limitBasis: 'known', model: null, at: 1,
});

// Stable, as App's are.
const onSelect = vi.fn();
const onNew = () => {};
const onRename = () => {};
const noContext = new Map<string, ContextUsage>();
const noSignals = new Map<number, TaskSignals>();
const noAttention = new Map<number, AttentionKind>();

type Props = Parameters<typeof TaskList>[0];
function list(over: Partial<Props> = {}) {
  return (
    <TaskList
      tasks={over.tasks ?? tasks}
      selectedId={over.selectedId ?? null}
      onSelect={over.onSelect ?? onSelect}
      onNew={onNew}
      onRename={onRename}
      contextBySession={over.contextBySession ?? noContext}
      signals={over.signals ?? noSignals}
      attention={over.attention ?? noAttention}
    />
  );
}

let tasks: Task[];
const rowOf = (id: number) => document.querySelector<HTMLElement>(`[data-task-id="${id}"]`)!;
/** Which rows drew since the last reset, by the context reading they drew. */
const drawn = () => h.rowRenders.length;

beforeEach(() => {
  // Newest first: 3, 2, 1.
  tasks = [mk(1, 1_000), mk(2, 2_000), mk(3, 3_000)];
  h.prs.clear();
  h.prVersion = 0;
  h.rowRenders = [];
  onSelect.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a memoised task row (#364)', () => {
  it('a new tasks array with one task changed redraws that row alone', () => {
    const { rerender } = render(list());
    expect(drawn()).toBe(3);
    h.rowRenders = [];
    tasks = tasks.map((t) => (t.id === 3 ? { ...t, lastActivityAt: 3_500 } : t));
    rerender(list());
    expect(drawn()).toBe(1);
    // And the same tasks again (a render of App for something else): none.
    h.rowRenders = [];
    rerender(list({ tasks: [...tasks] }));
    expect(drawn()).toBe(0);
  });

  it('a PR answer that leaves the row in its group still reaches it', () => {
    h.prs.set(1, openPr('MERGEABLE'));
    render(list());
    const group = rowOf(1).closest('[role="group"]')?.getAttribute('aria-labelledby');
    expect(rowOf(1).querySelector('[data-outcome="conflicts"]')).toBeNull();
    h.prs.set(1, openPr('CONFLICTING'));
    act(() => {
      h.prVersion += 1;
      for (const l of [...h.prListeners]) l();
    });
    expect(rowOf(1).querySelector('[data-outcome="conflicts"]')?.textContent).toBe('⚠ Conflicts');
    // Same group: only the PR cache's version could have redrawn the row.
    expect(rowOf(1).closest('[role="group"]')?.getAttribute('aria-labelledby')).toBe(group);
  });

  it('a context reading reaches its row, and only its row', () => {
    const { rerender } = render(list());
    h.rowRenders = [];
    rerender(list({ contextBySession: new Map([['s2', usage(0.8)]]) }));
    expect(h.rowRenders).toEqual([80]);
    expect(rowOf(2).querySelector('.task-ctx-text')?.textContent).toBe('80%');
    expect(rowOf(2).getAttribute('title')).toContain('\n');
  });

  it('signals reach their row: agents running, a question', () => {
    const { rerender } = render(list());
    rerender(list({ signals: new Map([[1, { agents: 2, question: true, finishedAt: null }]]) }));
    expect(rowOf(1).querySelector('.task-agents')?.textContent).toBe('·2');
    expect(rowOf(1).querySelector('.task-question')).not.toBeNull();
  });

  it('attention reaches its row, and leaves it', () => {
    const { rerender } = render(list());
    rerender(list({ attention: new Map([[2, 'blocked' as AttentionKind]]) }));
    expect(rowOf(2).getAttribute('data-attention')).toBe('blocked');
    rerender(list({ attention: new Map() }));
    expect(rowOf(2).hasAttribute('data-attention')).toBe(false);
  });

  it('the selection moves: the two rows involved redraw', () => {
    const { rerender } = render(list({ selectedId: 1 }));
    h.rowRenders = [];
    rerender(list({ selectedId: 3 }));
    expect(drawn()).toBe(2);
    expect(rowOf(3).getAttribute('aria-selected')).toBe('true');
    expect(rowOf(1).getAttribute('aria-selected')).toBe('false');
  });

  it('ages follow the clock', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(10_000);
    tasks = [mk(1, 1_000), mk(2, 2_000), mk(3, 3_000)];
    render(list());
    expect(rowOf(3).querySelector('.task-age')?.textContent).toBe('7s');
    act(() => {
      vi.setSystemTime(70_000);
      vi.advanceTimersByTime(15_000);
    });
    expect(rowOf(3).querySelector('.task-age')?.textContent).toBe('1m');
  });

  it('a click reaches the newest onSelect App handed down', () => {
    const { rerender } = render(list());
    const newer = vi.fn();
    rerender(list({ onSelect: newer }));
    fireEvent.click(rowOf(2));
    expect(newer).toHaveBeenCalledWith(2);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a row’s ⌘ number follows the order', () => {
    const { rerender } = render(list());
    const shortcuts = () => [1, 2, 3].map((id) => rowOf(id).querySelector('.task-index')?.textContent);
    expect(shortcuts()).toEqual(['⌘3', '⌘2', '⌘1']);
    tasks = tasks.map((t) => (t.id === 1 ? { ...t, lastActivityAt: 9_000 } : t));
    rerender(list());
    expect(shortcuts()).toEqual(['⌘1', '⌘3', '⌘2']);
  });

  it('Rename Task… opens the field on that row, and a save reaches onRename', () => {
    const rename = vi.fn();
    render(
      <TaskList tasks={tasks} selectedId={null} onSelect={onSelect} onNew={onNew} onRename={rename} actions={{ archive: () => {} }} />,
    );
    fireEvent.contextMenu(rowOf(2));
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }));
    const field = rowOf(2).querySelector('input')!;
    expect(field).not.toBeNull();
    fireEvent.change(field, { target: { value: 'Renamed' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(rename).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), 'Renamed');
    expect(rowOf(2).querySelector('input')).toBeNull();
  });
});
