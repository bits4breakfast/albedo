/**
 * Reminders (#156): a note on a task that comes back at its time as a card.
 *
 * ## The API (also what Albedo's MCP, #157, calls)
 *
 *   createReminder({ taskId, text, dueAt, createdBy, summary? }) → Reminder
 *
 * Records what was true when it was set -- the task's project, session and
 * transcript file, folder, branch and HEAD -- so it can come back sensibly
 * even if the task is gone by then. `dueAt` is epoch milliseconds; a time
 * already past fires at the next check (within a minute). `summary` is the
 * session's own brief, sent with the reminder if it comes back in a new task.
 * Throws {@link ReminderError} for empty text, a time that is not a number, or
 * a task that does not exist. Everything else here is for Albedo's own UI.
 *
 * ## Firing
 *
 * `startReminders` checks at once (so reminders due while Albedo was closed
 * fire on launch, each showing its original time) and then every minute.
 * Each due reminder is claimed (`claimDue`: fires once, however many checks
 * race), then delivered:
 *
 *   - to the task its card last showed on, or else the task it was set on,
 *     while that task is open (not archived) and its session can be resumed;
 *   - otherwise to a new task in the same project (replacement.ts).
 *
 * The task then shows the card above the message box, its row shows
 * "Reminder", and the person is told as for any other attention
 * (`noteReminder`: the row mark always; unfocused, a dock bounce and a banner).
 */

import { getTask } from '../db';
import {
  claimDue,
  closeReminder,
  deleteReminder as dbDeleteReminder,
  editReminder as dbEditReminder,
  getReminder,
  insertReminder,
  listDue,
  listUndelivered,
  listWaiting,
  setCardTask,
  snoozeReminder as dbSnoozeReminder,
  transcriptPathFor,
} from '../db/reminders';
import { probePath } from '../git/worktree';
import type { Reminder, ReminderAuthor, Task } from '../types';
import { headSnapshot } from './where';

export type { Reminder, ReminderAuthor, ReminderState } from '../types';
export { onRemindersChanged, listCards, cardTaskIds } from '../db/reminders';

export class ReminderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderError';
  }
}

export interface CreateReminderInput {
  /** The task it is set on. */
  taskId: number;
  /** What to be reminded of. Trimmed; must not be empty. */
  text: string;
  /** When it fires, epoch milliseconds. */
  dueAt: number;
  /** 'user' from Albedo's dialog, 'session' from a session through the MCP. */
  createdBy: ReminderAuthor;
  /** The session's own summary of where things stand, if it has one. */
  summary?: string | null;
}

/** Set a reminder on a task. See the module comment. */
export async function createReminder(input: CreateReminderInput): Promise<Reminder> {
  const text = input.text.trim();
  if (text === '') throw new ReminderError('A reminder needs some text.');
  if (!Number.isFinite(input.dueAt)) throw new ReminderError('A reminder needs a time.');
  const task = await getTask(input.taskId);
  if (!task) throw new ReminderError(`There is no task ${input.taskId}.`);
  const [transcriptPath, head] = await Promise.all([
    task.sessionId ? transcriptPathFor(task.sessionId).catch(() => null) : Promise.resolve(null),
    headSnapshot(task.worktreePath).catch(() => ({ branch: null, sha: null })),
  ]);
  const summary = input.summary?.trim() ?? '';
  return insertReminder({
    taskId: task.id,
    projectId: task.projectId,
    text,
    dueAt: Math.round(input.dueAt),
    createdBy: input.createdBy,
    sessionId: task.sessionId,
    transcriptPath,
    repoPath: task.repoPath,
    worktreePath: task.worktreePath,
    // '' marks a chat, as in the tasks table: it comes back as a chat.
    branch: task.kind === 'chat' ? '' : head.branch,
    headSha: head.sha,
    brief: summary === '' ? null : summary,
  });
}

/** A task's reminders still to come, soonest first: the dialog's list. */
export function listPendingReminders(taskId: number): Promise<Reminder[]> {
  return listWaiting(taskId);
}

/** New text and time for one still to come. False when it already fired. */
export async function updateReminder(id: number, patch: { text: string; dueAt: number }): Promise<boolean> {
  const text = patch.text.trim();
  if (text === '') throw new ReminderError('A reminder needs some text.');
  if (!Number.isFinite(patch.dueAt)) throw new ReminderError('A reminder needs a time.');
  return dbEditReminder(id, { text, dueAt: Math.round(patch.dueAt) });
}

export function deleteReminder(id: number): Promise<void> {
  return dbDeleteReminder(id);
}

/** Back at `dueAt`; its card goes until then. */
export function snoozeReminder(id: number, dueAt: number): Promise<void> {
  return dbSnoozeReminder(id, Math.round(dueAt));
}

export function dismissReminder(id: number): Promise<void> {
  return closeReminder(id, 'dismissed');
}

export function markReminderSent(id: number): Promise<void> {
  return closeReminder(id, 'sent');
}

export { getReminder };

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface DeliveryDeps {
  getTask: (id: number) => Promise<Task | null>;
  /** Whether the task's session can still be picked up. */
  resumable: (task: Task) => Promise<boolean>;
  /** A new task for the reminder (replacement.ts). */
  openReplacement: (r: Reminder) => Promise<Task>;
}

/**
 * The task whose card shows the reminder: where its card last showed (a
 * snoozed one comes back there), else the task it was set on -- while open
 * and resumable -- else a new one.
 */
export async function cardTaskFor(r: Reminder, deps: DeliveryDeps): Promise<{ task: Task; opened: boolean }> {
  const ids = [r.cardTaskId, r.taskId].filter((id, i, all): id is number => id !== null && all.indexOf(id) === i);
  for (const id of ids) {
    const task = await deps.getTask(id).catch(() => null);
    if (task && task.status !== 'archived' && (await deps.resumable(task).catch(() => true))) return { task, opened: false };
  }
  return { task: await deps.openReplacement(r), opened: true };
}

/**
 * Whether a task's session can still be resumed: it has none yet (a new one
 * starts), its pty is live, or its transcript is still on disk. Unknown --
 * Albedo holds no transcript file for it -- counts as resumable, as a spawn
 * does (sessionSpawn.ts): the cost of a wrong guess is a resume Terminal
 * already handles.
 */
export async function sessionResumable(
  task: Pick<Task, 'id' | 'sessionId'>,
  live: (taskId: number) => boolean,
): Promise<boolean> {
  if (task.sessionId === null || live(task.id)) return true;
  const path = await transcriptPathFor(task.sessionId).catch(() => null);
  if (path === null) return true;
  return probePath(path).catch(() => true);
}

/** What the scheduler tells the app about a reminder it delivered. */
export type ReminderNotice = (r: Reminder, task: Task) => void;

let checking: Promise<number> | null = null;

/**
 * Fire everything due by `now`, and retry any fired reminder no task took.
 * Returns how many cards were delivered. One check at a time: a second call
 * while one runs waits for it and returns its count.
 */
export function checkReminders(now: number, deps: DeliveryDeps, notice: ReminderNotice): Promise<number> {
  checking ??= (async () => {
    let delivered = 0;
    try {
      const due = await listDue(now);
      const claimed: Reminder[] = [];
      for (const r of due) if (await claimDue(r.id, now)) claimed.push(r);
      const retry = await listUndelivered();
      const ids = new Set(claimed.map((r) => r.id));
      for (const r of [...claimed, ...retry.filter((x) => !ids.has(x.id))]) {
        try {
          const { task } = await cardTaskFor(r, deps);
          await setCardTask(r.id, task.id);
          delivered++;
          try {
            notice({ ...r, state: 'fired', cardTaskId: task.id }, task);
          } catch (err) {
            console.warn('[reminders] notice failed:', err);
          }
        } catch (err) {
          // Stays fired with no card task; the next check tries again.
          console.warn(`[reminders] reminder ${r.id} could not be delivered:`, err);
        }
      }
    } finally {
      checking = null;
    }
    return delivered;
  })();
  return checking;
}

/** How often the scheduler looks. */
export const CHECK_EVERY_MS = 60_000;

/** Check now and every minute until the returned function is called. */
export function startReminders(deps: DeliveryDeps, notice: ReminderNotice): () => void {
  const run = () => {
    void checkReminders(Date.now(), deps, notice).catch((err: unknown) => {
      console.warn('[reminders] check failed:', err);
    });
  };
  run();
  const timer = setInterval(run, CHECK_EVERY_MS);
  return () => clearInterval(timer);
}
