/**
 * Create PR, from the task bar, the Review Guide or a task's ⋯ (#464): the
 * prompt to Claude (gitPrompts.ts), sent at once or held as every git
 * button's is (sendPrompt.ts), into the base the header shows (#237) when one
 * is given. Remembered only once it went somewhere -- sent, held, or left in
 * the message box -- so the draft it opens is marked ready for review once
 * its checks pass (gh/draftReady.ts). A send that went nowhere leaves no
 * record behind.
 */

import type { Task } from '../types';
import { notePrRequested } from '../gh/draftReady';
import { createPrPrompt } from './gitPrompts';
import { sendPrompt, type SendOutcome } from './sendPrompt';

export async function askCreatePr(task: Task, base: string, opts: { escape: boolean }): Promise<SendOutcome> {
  const outcome = await sendPrompt(task, createPrPrompt(base !== '' ? { ...task, baseBranch: base } : task));
  if (outcome !== 'failed') notePrRequested(task.id, opts.escape);
  else console.warn('[create-pr] the prompt could not be sent or left in the message box', task.id);
  return outcome;
}
