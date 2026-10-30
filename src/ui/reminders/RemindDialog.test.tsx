/**
 * @vitest-environment jsdom
 *
 * "Remind Me…" (#156): setting one from the dialog, the time read back in
 * words, and the task's list of reminders still to come.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createTestDb } from '../../db/testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import { createTask, resetDb } from '../../db';
import { listWaiting } from '../../db/reminders';
import { setGitRunner, type GitRunner } from '../../git/worktree';
import { createReminder } from '../../reminders';
import type { Task } from '../../types';
import RemindDialog, { chosenTime } from './RemindDialog';

let restoreGit: GitRunner;
let task: Task;

beforeEach(async () => {
  resetDb();
  harness.db = createTestDb();
  restoreGit = setGitRunner(async () => ({ code: 1, stdout: '', stderr: '' }));
  task = await createTask({
    title: 'fix login retry', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'b',
    worktreePath: '/wt/a', ownsWorktree: true, createdBranch: true, kind: 'work',
  });
});
afterEach(() => {
  cleanup();
  setGitRunner(restoreGit);
});

describe('chosenTime', () => {
  const now = new Date(2026, 9, 30, 14, 20);
  it('words win over the picker; the picker when there are none', () => {
    expect(chosenTime('tomorrow 9:00', '2026-12-01T10:00', now)).toBe(new Date(2026, 9, 31, 9).getTime());
    expect(chosenTime('', '2026-12-01T10:00', now)).toBe(new Date(2026, 11, 1, 10).getTime());
    expect(chosenTime('', '', now)).toBeNull();
    expect(chosenTime('whenever', '', now)).toBeNull();
  });
});

describe('RemindDialog', () => {
  it('sets a reminder from text and a time in words, then closes', async () => {
    const onClose = vi.fn();
    render(<RemindDialog task={task} onClose={onClose} />);
    const set = screen.getByRole('button', { name: /Set Reminder/ });
    expect((set as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Remind me to'), { target: { value: 'Check the deploy' } });
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'in 2 h' } });
    expect(screen.getByRole('status').textContent).toMatch(/^(today|tomorrow) \d\d:\d\d$/);
    await act(async () => {
      fireEvent.click(set);
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [r] = await listWaiting(task.id);
    expect(r).toMatchObject({ text: 'Check the deploy', createdBy: 'user', state: 'pending' });
    expect(Math.abs(r!.dueAt - (Date.now() + 2 * 3_600_000))).toBeLessThan(60_000);
  });

  it('says when it does not understand the time, and when it has passed', () => {
    render(<RemindDialog task={task} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Remind me to'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'whenever' } });
    expect(screen.getByRole('status').textContent).toMatch(/Not understood/);
    fireEvent.change(screen.getByLabelText('When'), { target: { value: '2020-01-01 10:00' } });
    expect(screen.getByRole('status').textContent).toBe('That time has passed.');
    expect((screen.getByRole('button', { name: /Set Reminder/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a quick choice fills the picker', () => {
    render(<RemindDialog task={task} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow 09:00' }));
    expect((screen.getByLabelText('Date and time') as HTMLInputElement).value).toMatch(/T09:00$/);
  });

  it('lists the task’s reminders to come; Edit reschedules one, Delete removes one', async () => {
    const soon = Date.now() + 3_600_000;
    const a = await createReminder({ taskId: task.id, text: 'Ping QA', dueAt: soon, createdBy: 'user' });
    await createReminder({ taskId: task.id, text: 'From Claude', dueAt: soon + 1000, createdBy: 'session' });
    render(<RemindDialog task={task} onClose={() => {}} />);
    expect(await screen.findByText('Ping QA')).toBeTruthy();
    expect(screen.getByText(/set by Claude/)).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    expect(screen.getByRole('heading', { name: 'Change Reminder' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Remind me to'), { target: { value: 'Ping QA again' } });
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'in 5 h' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    });
    await waitFor(async () => expect((await listWaiting(task.id)).find((r) => r.id === a.id)?.text).toBe('Ping QA again'));

    // Soonest first: Claude's (in 1 h) now comes before the moved one (in 5 h).
    await screen.findByText('Ping QA again');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await waitFor(async () => expect((await listWaiting(task.id)).map((r) => r.text)).toEqual(['Ping QA again']));
  });
});
