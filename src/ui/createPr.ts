/**
 * Create PR, from the task bar or the Review Guide (#464): remembered first,
 * so the draft it opens is marked ready for review once its checks pass
 * (gh/draftReady.ts), then the prompt to Claude (gitPrompts.ts), sent at once
 * or held as every git button's is (sendPrompt.ts). Into the base the header
 * shows (#237) when one is given.
 */

import type { Task } from '../types';
import { notePrRequested } from '../gh/draftReady';
import { createPrPrompt } from './gitPrompts';
import { sendPrompt } from './sendPrompt';

export function askCreatePr(task: Task, base: string, opts: { escape: boolean }): void {
  notePrRequested(task.id, opts.escape);
  void sendPrompt(task, createPrPrompt(base !== '' ? { ...task, baseBranch: base } : task));
}
