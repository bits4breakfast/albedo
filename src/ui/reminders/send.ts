/**
 * How a reminder card's "Send to Claude" reaches the session.
 *
 * Through the one send gateway (transcript/send.ts), as the buttons send:
 *
 *   - **Live and idle:** sent now.
 *   - **A turn running, messages already held, or offline:** held in the
 *     task's outbox and sent when the turn ends (`mustHold`).
 *   - **A question or permission prompt open, or no live session:** held in
 *     the outbox too. `sendPrompt` would leave it in the message box instead,
 *     but the message carries Albedo's reminder envelope, which is not text to
 *     edit; the outbox releases nothing into a prompt, and starts a session
 *     that is not running (as taskRename does for `/rename`). Edit… is the
 *     way to change the text first.
 *
 * Never typed into the pty here.
 */

import type { Reminder, Task } from '../../types';
import { hasLivePty } from '../Terminal';
import { holdMessage } from '../transcript/outbox';
import { mustHold, sendToSession } from '../transcript/send';
import { wrapReminder } from '../transcript/envelopes';
import { briefFor, withBrief } from '../../reminders/brief';
import { transcriptPathFor } from '../../db/reminders';

export interface ReminderSendDeps {
  mustHold: (taskId: number) => boolean;
  live: (taskId: number) => boolean;
  send: (taskId: number, text: string) => Promise<'sent' | 'held' | 'failed'>;
  hold: (taskId: number, text: string) => boolean;
}

const defaultDeps: ReminderSendDeps = {
  mustHold,
  live: hasLivePty,
  send: sendToSession,
  hold: (taskId, text) => holdMessage(taskId, text) !== null,
};

/** Where it went: to the session now, or into the outbox. */
export async function sendReminderText(
  task: Pick<Task, 'id' | 'status'>,
  text: string,
  deps: ReminderSendDeps = defaultDeps,
): Promise<'sent' | 'held' | 'failed'> {
  if (deps.mustHold(task.id) || (task.status !== 'blocked' && deps.live(task.id))) {
    return deps.send(task.id, text).catch(() => 'failed' as const);
  }
  return deps.hold(task.id, text) ? 'held' : 'failed';
}

/**
 * The text Claude gets for a reminder shown on `cardTaskId`: the reminder,
 * and -- when that is not the task it was set on -- the brief (brief.ts).
 */
export async function reminderPlainText(r: Reminder, cardTaskId: number): Promise<string> {
  if (cardTaskId === r.taskId) return r.text.trim();
  const path = r.transcriptPath ?? (r.sessionId ? await transcriptPathFor(r.sessionId).catch(() => null) : null);
  return withBrief(r.text, await briefFor(r, path));
}

/** The same, in Albedo's reminder envelope, so the transcript draws it as a reminder. */
export async function reminderMessage(r: Reminder, cardTaskId: number): Promise<string> {
  return wrapReminder({ text: await reminderPlainText(r, cardTaskId), setAt: r.createdAt, by: r.createdBy });
}
