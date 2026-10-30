/**
 * Reminders against a real SQLite with the shipped migrations (testkit):
 * what createReminder records, firing once, missed reminders on launch,
 * snooze, and where the card goes (the task it was set on, or a new one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../db/testkit';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => harness.db },
}));

import { archiveTask, createTask, deleteTask, getTask, resetDb, updateTask, upsertTranscriptFile } from '../db';
import { cardTaskIds, getReminder, listCards, listWaiting } from '../db/reminders';
import { setGitRunner, setPathExistsProbe, type GitRunner } from '../git/worktree';
import type { Reminder, Task } from '../types';
import {
  checkReminders,
  createReminder,
  dismissReminder,
  markReminderSent,
  ReminderError,
  sessionResumable,
  snoozeReminder,
  updateReminder,
  type DeliveryDeps,
} from './index';

let db: TestDb;
let restoreGit: GitRunner;
let restoreProbe: (path: string) => Promise<boolean>;

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

beforeEach(() => {
  resetDb();
  db = createTestDb();
  harness.db = db;
  restoreGit = setGitRunner(async (args) => {
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${SHA}\n`, stderr: '' };
    if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'fix/login-retry\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  });
  restoreProbe = setPathExistsProbe(async () => true);
});
afterEach(() => {
  setGitRunner(restoreGit);
  setPathExistsProbe(restoreProbe);
});

async function task(over: Partial<Parameters<typeof createTask>[0]> = {}): Promise<Task> {
  return createTask({
    title: 'fix login retry',
    projectId: 7,
    repoPath: '/repo',
    baseBranch: 'main',
    branch: 'fix/login-retry',
    worktreePath: `/wt/${Math.random()}`,
    ownsWorktree: true,
    createdBranch: true,
    kind: 'work',
    ...over,
  });
}

/** Delivery with no git and no ptys: everything open is resumable unless said. */
function deps(over: Partial<DeliveryDeps> = {}): DeliveryDeps & { opened: Reminder[] } {
  const opened: Reminder[] = [];
  return {
    opened,
    getTask,
    resumable: async () => true,
    openReplacement: async (r) => {
      opened.push(r);
      return task({ title: `Reminder: ${r.text}`, worktreePath: `/wt/new-${r.id}` });
    },
    ...over,
  };
}

const T0 = new Date(2026, 9, 30, 9, 0).getTime();

describe('createReminder', () => {
  it('records the task, its session and transcript, folder, branch and HEAD', async () => {
    const t = await task();
    await updateTask(t.id, { sessionId: 'sess-1' });
    await upsertTranscriptFile({
      path: '/home/.claude/projects/x/sess-1.jsonl', sessionId: 'sess-1', projectDir: 'x', cwd: t.worktreePath,
      title: null, bytesIngested: 10, lastSeq: 1, mtime: 1,
    });
    const r = await createReminder({ taskId: t.id, text: '  check the deploy  ', dueAt: T0, createdBy: 'session', summary: 'Retry fix merged; waiting on deploy.' });
    expect(r).toMatchObject({
      taskId: t.id,
      projectId: 7,
      text: 'check the deploy',
      dueAt: T0,
      createdBy: 'session',
      sessionId: 'sess-1',
      transcriptPath: '/home/.claude/projects/x/sess-1.jsonl',
      repoPath: '/repo',
      worktreePath: t.worktreePath,
      branch: 'fix/login-retry',
      headSha: SHA,
      brief: 'Retry fix merged; waiting on deploy.',
      state: 'pending',
      firedAt: null,
      cardTaskId: null,
    });
  });

  it("a chat records branch '' so it comes back as a chat; git failing records nulls", async () => {
    setGitRunner(async () => {
      throw new Error('no git');
    });
    const chat = await task({ kind: 'chat', branch: '', baseBranch: '' });
    const r = await createReminder({ taskId: chat.id, text: 'x', dueAt: T0, createdBy: 'user' });
    expect(r.branch).toBe('');
    expect(r.headSha).toBeNull();
    expect(r.brief).toBeNull();
  });

  it('refuses empty text, a time that is not a number, and an unknown task', async () => {
    const t = await task();
    await expect(createReminder({ taskId: t.id, text: '   ', dueAt: T0, createdBy: 'user' })).rejects.toBeInstanceOf(ReminderError);
    await expect(createReminder({ taskId: t.id, text: 'x', dueAt: NaN, createdBy: 'user' })).rejects.toBeInstanceOf(ReminderError);
    await expect(createReminder({ taskId: 999, text: 'x', dueAt: T0, createdBy: 'user' })).rejects.toThrow('no task 999');
  });

  it('edits text and time while waiting, and not once it has fired', async () => {
    const t = await task();
    const r = await createReminder({ taskId: t.id, text: 'a', dueAt: T0, createdBy: 'user' });
    expect(await updateReminder(r.id, { text: 'b', dueAt: T0 + 1000 })).toBe(true);
    expect(await getReminder(r.id)).toMatchObject({ text: 'b', dueAt: T0 + 1000 });
    await checkReminders(T0 + 1000, deps(), () => {});
    expect(await updateReminder(r.id, { text: 'c', dueAt: T0 + 5000 })).toBe(false);
    expect((await getReminder(r.id))!.text).toBe('b');
  });
});

describe('firing', () => {
  it('waits until due, then fires once onto its own open task, however often it is checked', async () => {
    const t = await task();
    const r = await createReminder({ taskId: t.id, text: 'check the deploy', dueAt: T0, createdBy: 'user' });
    const notices: Array<[number, number]> = [];
    const notice = (x: Reminder, to: Task) => notices.push([x.id, to.id]);

    expect(await checkReminders(T0 - 1, deps(), notice)).toBe(0);
    expect((await getReminder(r.id))!.state).toBe('pending');

    // Two checks racing (launch and the first minute) fire it once.
    // The second call waits for the one running and reports its count.
    const [a, b] = await Promise.all([checkReminders(T0, deps(), notice), checkReminders(T0, deps(), notice)]);
    expect([a, b]).toEqual([1, 1]);
    expect(await checkReminders(T0 + 60_000, deps(), notice)).toBe(0);
    expect(notices).toEqual([[r.id, t.id]]);

    const fired = await getReminder(r.id);
    expect(fired).toMatchObject({ state: 'fired', firedAt: T0, cardTaskId: t.id, dueAt: T0 });
    expect((await listCards(t.id)).map((x) => x.id)).toEqual([r.id]);
    expect(await cardTaskIds()).toEqual([t.id]);
  });

  it('fires reminders missed while Albedo was closed on the first check, keeping their time', async () => {
    const t = await task();
    const early = await createReminder({ taskId: t.id, text: 'yesterday', dueAt: T0 - 86_400_000, createdBy: 'user' });
    const later = await createReminder({ taskId: t.id, text: 'an hour ago', dueAt: T0 - 3_600_000, createdBy: 'user' });
    const launch = T0;
    expect(await checkReminders(launch, deps(), () => {})).toBe(2);
    const cards = await listCards(t.id);
    expect(cards.map((c) => c.id)).toEqual([early.id, later.id]);
    expect(cards[0]).toMatchObject({ dueAt: T0 - 86_400_000, firedAt: launch });
  });

  it('snooze takes the card away and brings it back to the same task, once', async () => {
    // The task it was set on is gone, so it came back in a new task the first time.
    const t = await task();
    const r = await createReminder({ taskId: t.id, text: 'retry', dueAt: T0, createdBy: 'user' });
    await deleteTask(t.id);
    const d = deps();
    await checkReminders(T0, d, () => {});
    const card = (await getReminder(r.id))!.cardTaskId!;
    expect(d.opened).toHaveLength(1);

    await snoozeReminder(r.id, T0 + 3_600_000);
    expect(await listCards(card)).toEqual([]);
    expect((await listWaiting(card)).map((x) => x.state)).toEqual(['snoozed']);
    expect(await checkReminders(T0 + 60_000, d, () => {})).toBe(0);

    expect(await checkReminders(T0 + 3_600_000, d, () => {})).toBe(1);
    // Back where its card was: no second new task.
    expect(d.opened).toHaveLength(1);
    expect(await getReminder(r.id)).toMatchObject({ state: 'fired', cardTaskId: card });
  });

  it('sent and dismissed are done: no card, no mark, never fired again', async () => {
    const t = await task();
    const a = await createReminder({ taskId: t.id, text: 'a', dueAt: T0, createdBy: 'user' });
    const b = await createReminder({ taskId: t.id, text: 'b', dueAt: T0, createdBy: 'user' });
    await checkReminders(T0, deps(), () => {});
    await markReminderSent(a.id);
    await dismissReminder(b.id);
    expect(await listCards(t.id)).toEqual([]);
    expect(await cardTaskIds()).toEqual([]);
    expect(await checkReminders(T0 + 86_400_000, deps(), () => {})).toBe(0);
    expect((await getReminder(a.id))!.state).toBe('sent');
    expect((await getReminder(b.id))!.state).toBe('dismissed');
  });

  it('a reminder no task took is tried again on the next check', async () => {
    const t = await task();
    await archiveTask(t.id);
    const r = await createReminder({ taskId: t.id, text: 'x', dueAt: T0, createdBy: 'user' });
    let fail = true;
    const d = deps({
      openReplacement: async (x) => {
        if (fail) throw new Error('git said no');
        return task({ title: `Reminder: ${x.text}` });
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await checkReminders(T0, d, () => {})).toBe(0);
    expect(await getReminder(r.id)).toMatchObject({ state: 'fired', cardTaskId: null });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    fail = false;
    expect(await checkReminders(T0 + 60_000, d, () => {})).toBe(1);
    expect((await getReminder(r.id))!.cardTaskId).not.toBeNull();
  });
});

describe('where the card goes', () => {
  it('archiving keeps the reminder, and it comes back in a new task', async () => {
    const t = await task();
    const r = await createReminder({ taskId: t.id, text: 'check', dueAt: T0, createdBy: 'user' });
    await archiveTask(t.id);
    expect((await getReminder(r.id))!.state).toBe('pending');
    const d = deps();
    const seen: number[] = [];
    await checkReminders(T0, d, (_x, to) => seen.push(to.id));
    expect(d.opened.map((x) => x.id)).toEqual([r.id]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(t.id);
    expect((await getReminder(r.id))!.cardTaskId).toBe(seen[0]);
  });

  it('a deleted task: a new task too', async () => {
    const t = await task();
    const r = await createReminder({ taskId: t.id, text: 'check', dueAt: T0, createdBy: 'user' });
    await deleteTask(t.id);
    const d = deps();
    await checkReminders(T0, d, () => {});
    expect(d.opened.map((x) => x.id)).toEqual([r.id]);
  });

  it('an open task whose session can no longer be resumed: a new task', async () => {
    const t = await task();
    await createReminder({ taskId: t.id, text: 'check', dueAt: T0, createdBy: 'user' });
    const d = deps({ resumable: async () => false });
    await checkReminders(T0, d, () => {});
    expect(d.opened).toHaveLength(1);
  });
});

describe('sessionResumable', () => {
  it('no session, or a live pty, is resumable without looking', async () => {
    const probe = vi.fn(async () => false);
    setPathExistsProbe(probe);
    expect(await sessionResumable({ id: 1, sessionId: null }, () => false)).toBe(true);
    expect(await sessionResumable({ id: 1, sessionId: 's' }, () => true)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('otherwise the transcript must still be on disk; none known counts as resumable', async () => {
    await upsertTranscriptFile({ path: '/p/s.jsonl', sessionId: 's', projectDir: 'p', cwd: '/w', title: null, bytesIngested: 1, lastSeq: 0, mtime: 1 });
    setPathExistsProbe(async (p) => p !== '/p/s.jsonl');
    expect(await sessionResumable({ id: 1, sessionId: 's' }, () => false)).toBe(false);
    setPathExistsProbe(async () => true);
    expect(await sessionResumable({ id: 1, sessionId: 's' }, () => false)).toBe(true);
    expect(await sessionResumable({ id: 1, sessionId: 'unknown' }, () => false)).toBe(true);
  });
});

describe('the migration', () => {
  it('creates the reminders table with the proposed columns', () => {
    const cols = (db.raw.prepare('PRAGMA table_info(reminders)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      'id', 'task_id', 'project_id', 'text', 'due_at', 'created_at', 'updated_at', 'created_by',
      'session_id', 'transcript_path', 'repo_path', 'worktree_path', 'branch', 'head_sha', 'brief',
      'state', 'fired_at', 'card_task_id',
    ]);
  });
});
