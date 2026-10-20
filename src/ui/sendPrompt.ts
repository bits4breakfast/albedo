/**
 * Hand a prompt to a task's session from a button: Push, Create PR, the
 * Squash & rebase dialog.
 *
 * The click is the decision, so on a live session the prompt is submitted at
 * once -- being made to press send as well is a second confirmation of
 * something already confirmed. That includes a running turn: Claude Code
 * queues a message typed while it works and takes it up next, exactly as it
 * does one sent from the message box. Only a permission prompt (typing into
 * it would answer it) or no session leave the prompt in the message box,
 * whose send path knows how to wait for those.
 */

import type { Task } from '../types';
import { hasLivePty, submitPty } from './Terminal';
import { insertIntoComposer } from './transcript/composerBridge';

/** Where the prompt went. `failed` means nothing was sent and nothing was put anywhere. */
export type SendOutcome = 'sent' | 'composer' | 'failed';

/** True when a prompt would be submitted now rather than waiting in the message box. */
export function canSubmitNow(task: Pick<Task, 'id' | 'status'>): boolean {
  return task.status !== 'blocked' && hasLivePty(task.id);
}

export async function sendPrompt(task: Pick<Task, 'id' | 'status'>, text: string): Promise<SendOutcome> {
  if (canSubmitNow(task)) {
    try {
      return (await submitPty(task.id, text)) ? 'sent' : 'failed';
    } catch {
      return 'failed';
    }
  }
  return insertIntoComposer({ taskId: task.id, text }) ? 'composer' : 'failed';
}
