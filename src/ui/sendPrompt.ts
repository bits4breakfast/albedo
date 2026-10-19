/**
 * Hand a prompt to a task's session from a button: Push, Create PR, the
 * Squash & rebase dialog.
 *
 * The click is the decision, so on a live, idle session the prompt is
 * submitted at once -- being made to press send as well is a second
 * confirmation of something already confirmed. Anywhere else it goes to the
 * message box instead, whose send path already knows how to wait: a running
 * turn, a permission prompt (typing into it would answer it), no session.
 */

import type { Task } from '../types';
import { hasLivePty, submitPty } from './Terminal';
import { insertIntoComposer } from './transcript/composerBridge';

/** Where the prompt went. `failed` means nothing was sent and nothing was put anywhere. */
export type SendOutcome = 'sent' | 'composer' | 'failed';

/** True when a prompt would be submitted now rather than waiting in the message box. */
export function canSubmitNow(task: Pick<Task, 'id' | 'status'>): boolean {
  return task.status === 'idle' && hasLivePty(task.id);
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
