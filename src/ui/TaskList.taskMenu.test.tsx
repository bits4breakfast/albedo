/**
 * @vitest-environment jsdom
 *
 * The row menu (#331) acts on the row's task, which need not be the selected
 * one, and reads that task's facts: Compact Now goes to the row's session and
 * is greyed by the row's own state, never the selected task's.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '../types';

const sent = vi.hoisted(() => [] as [number, string][]);
vi.mock('../gh/prStore', () => ({
  getPrStatus: () => null,
  usePrPolling: () => {},
  usePrStatusVersion: () => 0,
}));
vi.mock('../git/branchSync', () => ({ useBranchSync: () => {} }));
// Only task 11 has a live session.
vi.mock('./Terminal', () => ({
  hasLivePty: (id: number) => id === 11,
  ptyLiveSince: (id: number) => (id === 11 ? 1 : null),
  usePtyLiveSince: (id: number | null) => (id === 11 ? 1 : null),
  onPtyPresenceChange: () => () => {},
}));
vi.mock('./transcript/send', async (orig) => ({
  ...(await orig<typeof import('./transcript/send')>()),
  useSendsWait: () => false,
  sendToSession: async (taskId: number, text: string) => {
    sent.push([taskId, text]);
    return 'sent';
  },
}));
vi.mock('../db', async (orig) => ({
  ...(await orig<typeof import('../db')>()),
  remoteControlUrlSince: async () => null,
}));
Element.prototype.scrollIntoView = () => {};

const { default: TaskList } = await import('./TaskList');

afterEach(() => {
  cleanup();
  sent.length = 0;
});

function task(id: number, title: string, over: Partial<Task> = {}): Task {
  return {
    id, title, projectId: 1, repoPath: '/r/app', baseBranch: 'main', branch: `b-${id}`,
    worktreePath: `/w/${id}`, sessionId: `s${id}`, ownsWorktree: true, createdBranch: true, kind: 'work',
    status: 'idle', createdAt: 1, lastActivityAt: 1, seenAt: null, summary: null, reviewUrl: null, apiError: null, apiErrorText: null,
    ...over,
  };
}

const items = () => screen.getAllByRole('menuitem');
const item = (name: RegExp) => screen.getByRole('menuitem', { name });

function renderList(onSelect = vi.fn()) {
  const actions = { remind: vi.fn(), guide: vi.fn(), move: vi.fn(), archive: vi.fn(), delete: vi.fn() };
  const view = render(
    <TaskList
      tasks={[task(10, 'Fix login retry'), task(11, 'Speed up the build')]}
      selectedId={10}
      onSelect={onSelect}
      onNew={() => {}}
      onRename={() => {}}
      actions={actions}
    />,
  );
  const open = (id: number) => fireEvent.contextMenu(view.container.querySelector(`[data-task-id="${id}"]`) as HTMLElement);
  return { ...view, actions, onSelect, open };
}

describe('the row menu acts on its own task (#331)', () => {
  it('offers Compact Now on the row whose session is live, not the selected one', async () => {
    const { open, onSelect } = renderList();
    open(11);
    const compact = item(/Compact Now/) as HTMLButtonElement;
    expect(compact.disabled).toBe(false);
    // And Make Available Remotely, which needs a live session too.
    await screen.findByRole('menuitem', { name: /Make Available Remotely/ });
    fireEvent.click(compact);
    expect(sent).toEqual([[11, '/compact']]);
    expect(onSelect).not.toHaveBeenCalled();

    open(10);
    const greyed = item(/Compact Now/) as HTMLButtonElement;
    expect(greyed.disabled).toBe(true);
    expect(greyed.title).toBe('No session is running for this task.');
    expect(screen.queryByRole('menuitem', { name: /Make Available Remotely/ })).toBeNull();
  });

  it('hands the row’s task to every action, without selecting it', () => {
    const { open, actions, onSelect } = renderList();
    for (const [name, fn] of [
      [/Remind Me/, actions.remind],
      [/Review Guide/, actions.guide],
      [/Move to Main Checkout/, actions.move],
      [/Archive Task/, actions.archive],
      [/Delete Task/, actions.delete],
    ] as const) {
      open(11);
      fireEvent.click(item(name));
      expect(fn).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }));
      expect(screen.queryByRole('menu')).toBeNull();
    }
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('draws shortcuts on the right and the notes as tooltips, under the row’s name', () => {
    const { open } = renderList();
    open(11);
    expect(document.querySelector('.row-menu-head')?.textContent).toBe('Speed up the build');
    expect(document.querySelector('.row-menu-hint')).toBeNull();
    expect(item(/Rename Task/).querySelector('.row-menu-aside')?.textContent).toBe('⇧F6');
    expect(item(/Review Guide/).querySelector('.row-menu-aside')?.textContent).toBe('⇧⌘G');
    expect(item(/Delete Task/).getAttribute('title')).toMatch(/^Worktree optional, conversation kept/);
    expect(items().map((b) => b.querySelector('.row-menu-label')?.textContent)).toEqual([
      'Rename Task…',
      'Remind Me…',
      'Review Guide',
      'Compact Now',
      'Make Available Remotely',
      'Copy Session ID',
      'Copy Worktree Path',
      'Move to Main Checkout…',
      // No Mark as Done: this list was given no handler for it.
      'Archive Task…',
      'Delete Task…',
    ]);
  });
});
