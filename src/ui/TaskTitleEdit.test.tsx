/**
 * @vitest-environment jsdom
 *
 * Renaming a task in place (#152): the field itself, and the task row's
 * "Rename Task…" that opens it on the row.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../types';

vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));

const { default: TaskTitleEdit } = await import('./TaskTitleEdit');
const { default: TaskList } = await import('./TaskList');
const { default: OverflowMenu } = await import('./OverflowMenu');
const { RENAME_HINT, renameMenuItem } = await import('./taskRename');

afterEach(cleanup);

function field(): HTMLInputElement {
  return screen.getByRole('textbox', { name: 'Task name' }) as HTMLInputElement;
}

function open(title = 'Fix login') {
  const onSave = vi.fn();
  const onDone = vi.fn();
  const view = render(<TaskTitleEdit title={title} onSave={onSave} onDone={onDone} />);
  return { onSave, onDone, ...view };
}

describe('TaskTitleEdit', () => {
  it('opens focused, with the whole title selected, and says what a rename changes', () => {
    open();
    const input = field();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Fix login'.length);
    expect(input.title).toBe(RENAME_HINT);
  });

  it('Return saves the trimmed title, once', () => {
    const { onSave, onDone, unmount } = open();
    fireEvent.change(field(), { target: { value: '  Fix the login form  ' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.blur(field());
    unmount();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('Fix the login form');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('Escape cancels: nothing saved, whatever was typed', () => {
    const { onSave, onDone, unmount } = open();
    fireEvent.change(field(), { target: { value: 'Something else' } });
    fireEvent.keyDown(field(), { key: 'Escape' });
    fireEvent.blur(field());
    unmount();
    expect(onSave).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('leaving the field saves', () => {
    const { onSave } = open();
    fireEvent.change(field(), { target: { value: 'Renamed' } });
    fireEvent.blur(field());
    expect(onSave).toHaveBeenCalledWith('Renamed');
  });

  it('refuses empty or whitespace only: the old title stays', () => {
    const { onSave, onDone } = open();
    fireEvent.change(field(), { target: { value: '   ' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('an unchanged title saves nothing', () => {
    const { onSave, onDone } = open();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('removed without a blur (⌘] to another task), it still saves', () => {
    const { onSave, unmount } = open();
    fireEvent.change(field(), { target: { value: 'Renamed' } });
    unmount();
    expect(onSave).toHaveBeenCalledWith('Renamed');
  });

  it('keeps typed keys from the list behind it, but lets ⌘-chords through', () => {
    const behind = vi.fn();
    render(
      <div onKeyDown={(e) => behind(e.key)}>
        <TaskTitleEdit title="Fix login" onSave={() => {}} onDone={() => {}} />
      </div>,
    );
    fireEvent.keyDown(field(), { key: 'j' });
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: '1', metaKey: true });
    expect(behind.mock.calls).toEqual([['1']]);
  });
});

describe('the task row: Rename Task…', () => {
  const task: Task = {
    id: 7, title: 'Fix login', projectId: 1, repoPath: '/r/app', baseBranch: 'main', branch: 'fix-login',
    worktreePath: '/w/fix-login', sessionId: 's7', ownsWorktree: true, createdBranch: true, kind: 'work',
    status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: null,
  };

  it('is in the row menu, edits on the row without selecting it, and saves through onRename', () => {
    const onRename = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <TaskList tasks={[task]} selectedId={null} onSelect={onSelect} onNew={() => {}} onRename={onRename} />,
    );
    const row = container.querySelector('[data-task-id="7"]') as HTMLElement;
    fireEvent.contextMenu(row);
    const item = screen.getByRole('menuitem', { name: /Rename Task…/ });
    expect(item.getAttribute('title')).toBe(RENAME_HINT);
    fireEvent.click(item);

    const input = field();
    expect(row.contains(input)).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    // Typing j in the field is a letter, not a move down the list.
    fireEvent.keyDown(input, { key: 'j' });
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'Fix the login form' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith(task, 'Fix the login form');
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Task name' })).toBeNull();
  });

  it('is not offered without a handler', () => {
    const { container } = render(<TaskList tasks={[task]} selectedId={null} onSelect={() => {}} onNew={() => {}} />);
    fireEvent.contextMenu(container.querySelector('[data-task-id="7"]') as HTMLElement);
    expect(screen.queryByRole('menuitem', { name: /Rename Task/ })).toBeNull();
  });
});

describe('the task bar ⋯: Rename Task…', () => {
  it('shows ⇧F6 beside it and the hint on it, and opens the field when chosen', () => {
    const onSelect = vi.fn();
    render(<OverflowMenu label="Actions for Fix login" items={[renameMenuItem(onSelect)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Fix login' }));
    const item = screen.getByRole('menuitem', { name: /Rename Task…/ });
    expect(item.querySelector('.row-menu-aside')?.textContent).toBe('⇧F6');
    expect(item.getAttribute('title')).toBe(RENAME_HINT);
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('TaskTitleEdit: where focus goes after', () => {
  function Stage({ show, ...props }: { show: boolean } & Partial<Parameters<typeof TaskTitleEdit>[0]>) {
    return (
      <div>
        {/* Stands in for the task terminal's xterm textarea. */}
        <textarea aria-label="terminal" />
        <button type="button">elsewhere</button>
        {show && <TaskTitleEdit title="Fix login" onSave={() => {}} onDone={() => {}} {...props} />}
      </div>
    );
  }

  function startFromTerminal(props: Partial<Parameters<typeof TaskTitleEdit>[0]> = {}) {
    const view = render(<Stage show={false} {...props} />);
    const terminal = screen.getByLabelText('terminal');
    terminal.focus();
    view.rerender(<Stage show {...props} />);
    expect(document.activeElement).toBe(field());
    return { ...view, terminal };
  }

  it('Return and Escape go back to where the rename started (⇧F6 in the terminal)', () => {
    const fallback = vi.fn();
    const a = startFromTerminal({ fallbackFocus: fallback });
    fireEvent.change(field(), { target: { value: 'Renamed' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(document.activeElement).toBe(a.terminal);
    a.unmount();

    const b = startFromTerminal({ fallbackFocus: fallback });
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(document.activeElement).toBe(b.terminal);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a blur that moved nowhere (the window was left) comes back too', () => {
    const { terminal } = startFromTerminal();
    fireEvent.blur(field(), { relatedTarget: null });
    expect(document.activeElement).toBe(terminal);
  });

  it('focus moved to something else: it stays there', () => {
    const fallback = vi.fn();
    startFromTerminal({ fallbackFocus: fallback });
    const other = screen.getByRole('button', { name: 'elsewhere' });
    other.focus();
    expect(document.activeElement).toBe(other);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a click elsewhere that takes no focus: not stolen back', () => {
    const fallback = vi.fn();
    const { terminal } = startFromTerminal({ fallbackFocus: fallback });
    fireEvent.pointerDown(document.body);
    fireEvent.blur(field(), { relatedTarget: null });
    expect(document.activeElement).not.toBe(terminal);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('removed by a task switch (⌘1–9): nothing is refocused', () => {
    const fallback = vi.fn();
    const { rerender, terminal } = startFromTerminal({ fallbackFocus: fallback });
    rerender(<Stage show={false} fallbackFocus={fallback} />);
    expect(document.activeElement).not.toBe(terminal);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('from a menu or a double-click: the fallback (the task terminal), not the element before', () => {
    const fallback = vi.fn();
    const { terminal } = startFromTerminal({ returnFocus: 'fallback', fallbackFocus: fallback });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(terminal);
  });

  it('the element before is gone (the ⋯ item it was chosen from): the fallback', () => {
    const fallback = vi.fn();
    const view = render(
      <div>
        <button type="button">menu item</button>
      </div>,
    );
    screen.getByRole('button', { name: 'menu item' }).focus();
    view.rerender(
      <div>
        <TaskTitleEdit title="Fix login" onSave={() => {}} onDone={() => {}} fallbackFocus={fallback} />
      </div>,
    );
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('the task row: closing its field goes to onRenameClosed', () => {
    const closed = vi.fn();
    const task: Task = {
      id: 8, title: 'Fix login', projectId: 1, repoPath: '/r/app', baseBranch: 'main', branch: 'fix-login',
      worktreePath: '/w/fix-login', sessionId: 's8', ownsWorktree: true, createdBranch: true, kind: 'work',
      status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: null,
    };
    const { container } = render(
      <TaskList tasks={[task]} selectedId={null} onSelect={() => {}} onNew={() => {}} onRename={() => {}} onRenameClosed={closed} />,
    );
    fireEvent.contextMenu(container.querySelector('[data-task-id="8"]') as HTMLElement);
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename Task…/ }));
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
