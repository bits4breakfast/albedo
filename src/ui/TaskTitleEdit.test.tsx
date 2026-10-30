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
