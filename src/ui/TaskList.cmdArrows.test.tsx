/**
 * @vitest-environment jsdom
 *
 * ⌘↑ / ⌘↓ step through the task list as ⌘[ / ⌘] do (#398), in the order on
 * screen -- and not in a text field, where they are start and end of text.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Terminal as XTerm } from '@xterm/xterm';
import type { Task } from '../types';
import { TASK_TERMINAL_ATTR, taskTerminalTakesKey } from './shortcuts';

vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));

const { default: TaskList } = await import('./TaskList');

// jsdom has no layout; the list scrolls the selected row into view.
Element.prototype.scrollIntoView ??= () => {};

// macOS only: the webview's user agent says which platform this is.
beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// xterm asks for it; jsdom has none.
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  });
}

const base = {
  projectId: 1, repoPath: '/r/app', sessionId: null, createdBranch: false, baseBranch: 'main', ownsWorktree: true,
  kind: 'work', status: 'idle', createdAt: 1, seenAt: null, summary: null, reviewUrl: null, apiError: null,
  apiErrorText: null, spunFromTaskId: null,
} as const;
const task = (id: number, lastActivityAt: number): Task => ({
  ...base, id, title: `Task ${id}`, branch: `b${id}`, worktreePath: `/w/b${id}`, lastActivityAt,
});
const tasks = [task(1, 3), task(2, 2), task(3, 1)];

function setup(selectedId: number) {
  const onSelect = vi.fn();
  render(
    <div>
      <TaskList tasks={tasks} selectedId={selectedId} onSelect={onSelect} onNew={() => {}} />
      <textarea aria-label="message" />
    </div>,
  );
  const order = Array.from(document.querySelectorAll('[data-task-id]')).map((el) => Number(el.getAttribute('data-task-id')));
  return { onSelect, order };
}

describe('⌘↑ / ⌘↓ in the task list (#398)', () => {
  it('select the previous and next task, as ⌘[ and ⌘] do', () => {
    const { onSelect, order } = setup(tasks[1]!.id);
    const i = order.indexOf(tasks[1]!.id);
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(order.length - 1);

    fireEvent.keyDown(document.body, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'ArrowUp', code: 'ArrowUp', metaKey: true });
    fireEvent.keyDown(document.body, { key: ']', metaKey: true });
    fireEvent.keyDown(document.body, { key: '[', metaKey: true });
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual([order[i + 1], order[i - 1], order[i + 1], order[i - 1]]);
  });

  it('step once from a row: the row’s own ↓ leaves Command to them', () => {
    const { onSelect, order } = setup(tasks[1]!.id);
    const i = order.indexOf(tasks[1]!.id);
    const row = document.querySelector<HTMLElement>(`[data-task-id="${tasks[1]!.id}"]`)!;
    fireEvent.keyDown(row, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true });
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual([order[i + 1]]);
  });

  it('step from the task terminal, where focus lands after a selection; the pty gets nothing', () => {
    const { onSelect, order } = setup(tasks[1]!.id);
    const i = order.indexOf(tasks[1]!.id);
    // A real xterm, wired and marked as Terminal.tsx wires and marks it.
    const host = document.body.appendChild(document.createElement('div'));
    const term = new XTerm();
    const pty: string[] = [];
    term.onData((d) => void pty.push(d));
    term.attachCustomKeyEventHandler(taskTerminalTakesKey);
    term.open(host);
    term.textarea!.setAttribute(TASK_TERMINAL_ATTR, '');
    try {
      term.textarea!.focus();
      fireEvent.keyDown(term.textarea!, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, metaKey: true });
      expect(onSelect.mock.calls.map((c) => c[0])).toEqual([order[i - 1]]);
      expect(pty).toEqual([]);
    } finally {
      term.dispose();
      host.remove();
    }
  });

  it('step once per press, and not under a modal dialog', () => {
    const { onSelect, order } = setup(tasks[1]!.id);
    const i = order.indexOf(tasks[1]!.id);
    fireEvent.keyDown(document.body, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, repeat: true });
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('aria-modal', 'true');
    fireEvent.keyDown(document.body, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true });
    dialog.remove();
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual([order[i + 1]]);
  });

  it('leave a text field alone', () => {
    const { onSelect } = setup(tasks[1]!.id);
    const field = screen.getByLabelText('message');
    field.focus();
    const e = fireEvent.keyDown(field, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true });
    expect(e).toBe(true); // not prevented: the caret goes to the end of the text
    fireEvent.keyDown(field, { key: 'ArrowUp', code: 'ArrowUp', metaKey: true });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('do nothing with Shift, Option or Control', () => {
    const { onSelect } = setup(tasks[1]!.id);
    fireEvent.keyDown(document.body, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

