/**
 * @vitest-environment jsdom
 *
 * The reminder card (#156) as it is clicked: what it shows, and what each
 * button does to the session and the row. Real SQLite underneath; the send
 * gateway and the pty are stand-ins, so "sent now" and "held" are observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createTestDb } from '../../db/testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));
const gw = vi.hoisted(() => ({
  live: new Set<number>(),
  turn: new Set<number>(),
  sent: [] as Array<[number, string]>,
  held: [] as Array<[number, string]>,
}));
vi.mock('../Terminal', () => ({ hasLivePty: (id: number) => gw.live.has(id) }));
vi.mock('../transcript/send', () => ({
  mustHold: (id: number) => gw.turn.has(id),
  sendToSession: async (id: number, text: string) => {
    if (gw.turn.has(id)) {
      gw.held.push([id, text]);
      return 'held';
    }
    gw.sent.push([id, text]);
    return 'sent';
  },
}));
vi.mock('../transcript/outbox', () => ({
  holdMessage: (id: number, text: string) => {
    gw.held.push([id, text]);
    return { id: 'h', text, heldAt: 0 };
  },
}));

import { createTask, resetDb } from '../../db';
import { getReminder } from '../../db/reminders';
import { setGitRunner, type GitRunner } from '../../git/worktree';
import { checkReminders, createReminder } from '../../reminders';
import { onComposerInsert, type ComposerInsert } from '../transcript/composerBridge';
import { parseUserBody } from '../transcript/envelopes';
import type { Task } from '../../types';
import ReminderCards from './ReminderCard';
import { sendReminderText } from './send';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const T0 = new Date(2026, 9, 30, 9, 0).getTime();
let restoreGit: GitRunner;
let head = SHA;

beforeEach(() => {
  resetDb();
  harness.db = createTestDb();
  gw.live.clear();
  gw.turn.clear();
  gw.sent = [];
  gw.held = [];
  head = SHA;
  restoreGit = setGitRunner(async (args) => {
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${head}\n`, stderr: '' };
    if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'fix/login-retry\n', stderr: '' };
    if (args[0] === 'cat-file') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-list') return { code: 0, stdout: '0\t3\n', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  });
});
afterEach(() => {
  cleanup();
  setGitRunner(restoreGit);
});

async function firedOn(): Promise<{ task: Task; id: number }> {
  const task = await createTask({
    title: 'fix login retry', projectId: 1, repoPath: '/repo', baseBranch: 'main', branch: 'fix/login-retry',
    worktreePath: '/wt/a', ownsWorktree: true, createdBranch: true, kind: 'work',
  });
  const r = await createReminder({ taskId: task.id, text: 'Check whether the retry fix held.', dueAt: T0, createdBy: 'user' });
  await checkReminders(T0, { getTask: async () => task, resumable: async () => true, openReplacement: async () => task }, () => {});
  return { task, id: r.id };
}

describe('sendReminderText: the send gateway, never the message box', () => {
  const deps = (o: { hold?: boolean; live?: boolean }) => ({
    mustHold: () => o.hold ?? false,
    live: () => o.live ?? true,
    send: vi.fn(async () => (o.hold ? 'held' : 'sent') as 'held' | 'sent'),
    hold: vi.fn(() => true),
  });

  it('idle and live: sent now', async () => {
    const d = deps({});
    expect(await sendReminderText({ id: 1, status: 'idle' }, 'x', d)).toBe('sent');
    expect(d.send).toHaveBeenCalledWith(1, 'x');
  });

  it('a turn running: through the gateway, which holds it until the turn ends', async () => {
    const d = deps({ hold: true });
    expect(await sendReminderText({ id: 1, status: 'running' }, 'x', d)).toBe('held');
    expect(d.send).toHaveBeenCalled();
  });

  it('a prompt waiting, or no session running: held in the outbox, never typed', async () => {
    for (const d of [deps({}), deps({ live: false })]) {
      const status = d.live() ? 'blocked' : 'idle';
      expect(await sendReminderText({ id: 1, status }, 'x', d)).toBe('held');
      expect(d.send).not.toHaveBeenCalled();
      expect(d.hold).toHaveBeenCalledWith(1, 'x');
    }
  });
});

describe('the card', () => {
  it('shows who set it and when, the text, and where HEAD is now', async () => {
    const { task } = await firedOn();
    head = 'ffffffffffffffffffffffffffffffffffffffff';
    render(<ReminderCards taskId={task.id} status="idle" />);
    expect(await screen.findByText('Check whether the retry fix held.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Reminder' })).toBeTruthy();
    expect(screen.getByText(/due today 09:00 · set Oct 30 by you/)).toBeTruthy();
    expect(await screen.findByText('Task was at a1b2c3d on fix/login-retry · now 3 ahead')).toBeTruthy();
  });

  it('Send to Claude, idle: sent now as a reminder envelope, and the card goes', async () => {
    const { task, id } = await firedOn();
    gw.live.add(task.id);
    render(<ReminderCards taskId={task.id} status="idle" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude' }));
    await waitFor(() => expect(gw.sent).toHaveLength(1));
    expect(gw.held).toEqual([]);
    const [block] = parseUserBody(gw.sent[0]![1]);
    expect(block).toMatchObject({ kind: 'reminder', by: 'user', text: 'Check whether the retry fix held.' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Reminder' })).toBeNull());
    expect((await getReminder(id))!.state).toBe('sent');
  });

  it('Send to Claude during a turn: held, not typed into the turn', async () => {
    const { task } = await firedOn();
    gw.live.add(task.id);
    gw.turn.add(task.id);
    render(<ReminderCards taskId={task.id} status="running" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude' }));
    await waitFor(() => expect(gw.held).toHaveLength(1));
    expect(gw.sent).toEqual([]);
  });

  it('Send to Claude on a waiting prompt: held in the outbox, never typed into the prompt', async () => {
    const { task } = await firedOn();
    gw.live.add(task.id);
    render(<ReminderCards taskId={task.id} status="blocked" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude' }));
    await waitFor(() => expect(gw.held).toHaveLength(1));
    expect(gw.sent).toEqual([]);
  });

  it('Dismiss ends it', async () => {
    const { task, id } = await firedOn();
    render(<ReminderCards taskId={task.id} status="idle" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Reminder' })).toBeNull());
    expect((await getReminder(id))!.state).toBe('dismissed');
  });

  it('Edit… puts the plain text in the message box; sent from there, the reminder is done', async () => {
    const { task, id } = await firedOn();
    const got: ComposerInsert[] = [];
    const off = onComposerInsert((i) => {
      got.push(i);
      return true;
    });
    render(<ReminderCards taskId={task.id} status="idle" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit…' }));
    await waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]).toMatchObject({ taskId: task.id, text: 'Check whether the retry fix held.' });
    expect(gw.sent).toEqual([]);
    expect(await screen.findByText(/In the message box/)).toBeTruthy();
    // Something unrelated sent first does not count.
    expect(got[0]!.onSent!('hello')).toBe(false);
    expect(got[0]!.onSent!('Check whether the retry fix held. Also the logs.')).toBe(true);
    await waitFor(async () => expect((await getReminder(id))!.state).toBe('sent'));
    off();
  });

  it('Snooze ▾ In 1 Hour: the card goes and it waits again', async () => {
    const { task, id } = await firedOn();
    render(<ReminderCards taskId={task.id} status="idle" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Snooze' }));
    const before = Date.now();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'In 1 Hour' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Reminder' })).toBeNull());
    const r = await getReminder(id);
    expect(r!.state).toBe('snoozed');
    expect(r!.dueAt).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it('Snooze ▾ Custom…: a time in words, Enter to snooze', async () => {
    const { task, id } = await firedOn();
    render(<ReminderCards taskId={task.id} status="idle" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Snooze' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Custom…' }));
    const field = await screen.findByRole('textbox', { name: 'Snooze until' });
    await act(async () => {
      fireEvent.change(field, { target: { value: 'in 3 h' } });
    });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(async () => expect((await getReminder(id))!.state).toBe('snoozed'));
  });
});
