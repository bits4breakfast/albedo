/**
 * "Follow-up…": a new task for a bug found in work that already shipped.
 *
 * Pure. It only builds what the new-task dialog is prefilled with; the user
 * edits all of it and creates the task themselves. Nothing here creates
 * anything, and nothing records which task a follow-up came from -- that would
 * need a `followup_of` column (docs/TODO.md).
 *
 * The prompt points Claude at what shipped rather than restating it: the PR
 * when one is known, otherwise the branch and git. Claude Code reads both
 * itself; Albedo only names them.
 */

import type { Task } from '../types';
import type { PrStatus } from '../gh/prStatus';
import { parseIssueKey } from '../lib/issueKey';
import { nameTask } from '../git/slug';

/** What the new-task dialog opens with. */
export interface NewTaskPrefill {
  /** Preselected project; the dialog's usual default when null or gone. */
  projectId: number | null;
  title: string;
  /** Initial prompt, editable. Replaces the project's template for this task. */
  prompt: string;
  /**
   * The shipped task's worktree, so the dialog can say so when the new one
   * would land on the same path (a keyed title keeps the bare-key folder).
   */
  originalWorktreePath: string;
  /** True while the PR is still being looked up (archived tasks). */
  pending?: boolean;
}

/**
 * `ACME-2398 follow-up` for a keyed title, `Follow-up: <title>` otherwise.
 *
 * The title must not name the shipped task's branch again -- a follow-up of a
 * follow-up would -- so a number is appended until it does not.
 */
export function followUpTitle(task: Pick<Task, 'title' | 'branch'>): string {
  const issue = parseIssueKey(task.title);
  const base = issue ? `${issue.key} follow-up` : `Follow-up: ${task.title.trim()}`;
  let title = base;
  for (let n = 2; n < 100 && nameTask(title).branch === task.branch; n++) {
    title = `${base} ${n}`;
  }
  return title;
}

/**
 * The initial prompt. Ends on an empty line under a heading so the one thing
 * only the user knows -- what is wrong -- has an obvious place to go.
 */
export function followUpPrompt(
  task: Pick<Task, 'branch' | 'baseBranch'>,
  pr: Pick<PrStatus, 'number' | 'url' | 'state'> | null,
): string {
  const base = task.baseBranch;
  const lines =
    pr && pr.state === 'merged'
      ? [
          `This is a follow-up to PR #${pr.number} (${pr.url}), branch \`${task.branch}\`. ` +
            `It is already merged into \`${base}\`.`,
          '',
          `Before changing anything, read what shipped: \`gh pr view ${pr.number}\` and ` +
            `\`gh pr diff ${pr.number}\`.`,
        ]
      : [
          `This is a follow-up to the work on branch \`${task.branch}\`, which should already ` +
            `be merged into \`${base}\`.`,
          '',
          `Before changing anything, read what shipped: \`git log --oneline ${base}..${task.branch}\` ` +
            `and \`git diff ${base}...${task.branch}\` if the branch still exists, otherwise ` +
            `\`git log ${base}\` for its merge.`,
        ];
  return [...lines, '', 'What is wrong:', '', ''].join('\n');
}

/** Everything the dialog is prefilled with for a follow-up of `task`. */
export function buildFollowUp(
  task: Pick<Task, 'title' | 'branch' | 'baseBranch' | 'projectId' | 'worktreePath'>,
  pr: Pick<PrStatus, 'number' | 'url' | 'state'> | null,
): NewTaskPrefill {
  return {
    projectId: task.projectId,
    title: followUpTitle(task),
    prompt: followUpPrompt(task, pr),
    originalWorktreePath: task.worktreePath,
  };
}

/** Whether a task offers "Follow-up…": its PR is merged, or it is archived. */
export function canFollowUp(
  task: Pick<Task, 'status'>,
  pr: Pick<PrStatus, 'state'> | null | undefined,
): boolean {
  return task.status === 'archived' || pr?.state === 'merged';
}
