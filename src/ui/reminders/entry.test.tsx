/**
 * @vitest-environment jsdom
 *
 * The ways in and the mark (#156): "Remind Me…" in the task's ⋯ opens the
 * dialog, and a task showing a reminder card says "Reminder" on its row --
 * not on the selected row, whose card is right there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createTestDb } from '../../db/testkit';
import type { Task } from '../../types';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => harness.db } }));
vi.mock('../../gh/prStore', () => ({ getPrStatus: () => null, usePrPolling: () => {}, usePrStatusVersion: () => 0 }));
vi.mock('../../git/branchSync', () => ({ useBranchSync: () => {} }));
Element.prototype.scrollIntoView = () => {};

const { default: TaskList } = await import('../TaskList');
const { default: OverflowMenu } = await import('../OverflowMenu');
const { createTask, resetDb } = await import('../../db');
const { setGitRunner } = await import('../../git/worktree');
const { checkReminders, createReminder, dismissReminder } = await import('../../reminders');
const { remindMenuItem } = await import('./menuItem');

beforeEach(() => {
  resetDb();
  harness.db = createTestDb();
  setGitRunner(async () => ({ code: 1, stdout: '', stderr: '' }));
});
afterEach(cleanup);

describe('Remind Me… in the ⋯ menu', () => {
  it('is offered, counts what is set, and opens the dialog', () => {
    const open = vi.fn();
    render(<OverflowMenu label="Task actions" items={[remindMenuItem(2, open)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Task actions' }));
    const item = screen.getByRole('menuitem', { name: /Remind Me…/ });
    expect(item.textContent).toContain('2 set');
    fireEvent.click(item);
    expect(open).toHaveBeenCalled();
    expect(remindMenuItem(0, open).aside).toBeUndefined();
  });
});

describe('the Reminder mark on a row', () => {
  it('shows while a card is on the task, not on the selected row, and goes with the card', async () => {
    const mk = (title: string, wt: string) =>
      createTask({ title, projectId: 1, repoPath: '/r', baseBranch: 'main', branch: title, worktreePath: wt, ownsWorktree: true, createdBranch: true, kind: 'work' });
    const a: Task = await mk('a', '/w/a');
    const b: Task = await mk('b', '/w/b');
    const ra = await createReminder({ taskId: a.id, text: 'x', dueAt: 1, createdBy: 'user' });
    await createReminder({ taskId: b.id, text: 'y', dueAt: 1, createdBy: 'user' });
    await checkReminders(2, { getTask: async (id) => (id === a.id ? a : b), resumable: async () => true, openReplacement: async () => a }, () => {});

    const { container } = render(<TaskList tasks={[a, b]} selectedId={b.id} onSelect={() => {}} onNew={() => {}} />);
    const marked = () => [...container.querySelectorAll('.task-reminder')].map((el) => el.closest('[data-task-id]')?.getAttribute('data-task-id'));
    await waitFor(() => expect(marked()).toEqual([String(a.id)]));
    expect(container.querySelector('.task-reminder')?.textContent).toBe('Reminder');
    await dismissReminder(ra.id);
    await waitFor(() => expect(marked()).toEqual([]));
  });
});
