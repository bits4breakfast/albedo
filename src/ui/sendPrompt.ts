/**
 * Hand a prompt to a task's session from a button: Push, Create PR, the
 * Squash & rebase dialog.
 *
 * The click is the decision, so on a live session the prompt is submitted at
 * once -- being made to press send as well is a second confirmation of
 * something already confirmed. During a running turn it is held in the
 * task's outbox and goes when the turn ends, exactly as one sent from the
 * message box. Only a permission prompt (typing into it would answer it) or
 * no session leave the prompt in the message box,
 * whose send path knows how to wait for those.
 *
 * It goes through the one send gateway (transcript/send.ts): offline, or
 * behind messages already held, it is held in the task's outbox too, and its
 * write never overlaps another send to the same session.
 */

import type { Task } from '../types';
import { hasLivePty } from './Terminal';
import { insertIntoComposer } from './transcript/composerBridge';
import { mustHold, sendToSession } from './transcript/send';

/**
 * Where the prompt went. `held`: in the task's outbox, sent by itself once it
 * can go. `failed` means nothing was sent and nothing was put anywhere.
 */
export type SendOutcome = 'sent' | 'held' | 'composer' | 'failed';

/** True when a prompt would be submitted now rather than waiting in the message box. */
export function canSubmitNow(task: Pick<Task, 'id' | 'status'>): boolean {
  return task.status !== 'blocked' && hasLivePty(task.id);
}

export async function sendPrompt(task: Pick<Task, 'id' | 'status'>, text: string): Promise<SendOutcome> {
  if (mustHold(task.id) || canSubmitNow(task)) return sendToSession(task.id, text);
  return insertIntoComposer({ taskId: task.id, text }) ? 'composer' : 'failed';
}
