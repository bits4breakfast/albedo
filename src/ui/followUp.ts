/**
 * "Follow-up…": a new task for a bug found in work that already shipped.
 *
 * Pure. It only builds what the new-task dialog is prefilled with; the user
 * edits all of it and creates the task themselves. Nothing here creates
 * anything, and nothing records which task a follow-up came from -- that would
 * need a `followup_of` column (#35).
 *
 * The prompt points Claude at what shipped rather than restating it: the PR
 * when one is known, otherwise the branch and git. Claude Code reads both
 * itself; Albedo only names them.
 */

import type { Task } from '../types';
import type { PrStatus } from '../gh/prStatus';
import { parseIssueKey } from '../lib/issueKey';
import { nameTask, type TaskNaming } from '../git/slug';

/** What the new-task dialog opens with. */
export interface NewTaskPrefill {
  /** Preselected project; the dialog's usual default when null or gone. */
  projectId: number | null;
  title: string;
  /** Initial prompt, editable. Replaces the project's template for this task. */
  prompt: string;
  /** True while the PR is still being looked up (archived tasks). */
  pending?: boolean;
}

/**
 * How a follow-up is named: as `nameTask`, except that the folder is the
 * branch rather than the bare issue key.
 *
 * A normal keyed task keeps the one-worktree-per-issue folder (`ACME-2398`);
 * existing tasks and reconcile rely on it, so that rule is untouched. A
 * follow-up is the exception it was not written for: it is usually created
 * right after the merge, while the shipped task's worktree still occupies that
 * folder. The branch is already distinct, and safe as a path segment.
 */
export function nameFollowUp(title: string): TaskNaming {
  const n = nameTask(title);
  return { ...n, dirName: n.branch };
}

/** `ACME-2398 follow-up`, `… follow-up 2`, … (or `Follow-up: <title>`, …). */
function* followUpTitles(task: Pick<Task, 'title'>): Generator<string> {
  const issue = parseIssueKey(task.title);
  const base = issue ? `${issue.key} follow-up` : `Follow-up: ${task.title.trim()}`;
  yield base;
  for (let n = 2; n < 100; n++) yield `${base} ${n}`;
}

/**
 * `ACME-2398 follow-up` for a keyed title, `Follow-up: <title>` otherwise.
 *
 * The title must not name the shipped task's branch again -- a follow-up of a
 * follow-up would -- so a number is appended until it does not.
 */
export function followUpTitle(task: Pick<Task, 'title' | 'branch'>): string {
  for (const title of followUpTitles(task)) {
    if (nameFollowUp(title).branch !== task.branch) return title;
  }
  return `Follow-up: ${task.title.trim()}`;
}

/**
 * The first follow-up title whose branch and folder are both free: not the
 * shipped task's branch, and nothing `isTaken` reports (an existing branch,
 * worktree, task path or directory). A second follow-up of the same task
 * therefore lands on `-follow-up-2` rather than on the first one.
 */
export async function freeFollowUpTitle(
  task: Pick<Task, 'title' | 'branch'>,
  isTaken: (naming: TaskNaming) => boolean | Promise<boolean>,
): Promise<string> {
  for (const title of followUpTitles(task)) {
    const naming = nameFollowUp(title);
    if (naming.branch === task.branch) continue;
    if (!(await isTaken(naming))) return title;
  }
  return followUpTitle(task);
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
  task: Pick<Task, 'title' | 'branch' | 'baseBranch' | 'projectId'>,
  pr: Pick<PrStatus, 'number' | 'url' | 'state'> | null,
  /** From {@link freeFollowUpTitle}, when the caller has checked the disk. */
  title: string = followUpTitle(task),
): NewTaskPrefill {
  return {
    projectId: task.projectId,
    title,
    prompt: followUpPrompt(task, pr),
  };
}

/** What is already on the machine, for {@link followUpTaken}. */
export interface TakenNames {
  /** Branches in the repository, and every task's branch. */
  branches: Iterable<string>;
  /** Paths of the repository's worktrees, and every task's worktree path. */
  paths: Iterable<string>;
  /** Where a folder would be: the project's worktree root plus `dirName`. */
  pathFor: (dirName: string) => string;
  /** Whether anything is on disk at a path; the I/O, injected. */
  exists: (path: string) => Promise<boolean>;
}

/**
 * The `isTaken` for {@link freeFollowUpTitle}: a naming is taken when its
 * branch exists or is a task's, or its folder is a worktree, a task's path, or
 * simply already on disk. A probe that fails counts as taken -- skipping a
 * free name costs a digit, using a taken one costs a refusal from git.
 */
export function followUpTaken(known: TakenNames): (naming: TaskNaming) => Promise<boolean> {
  const branches = new Set(known.branches);
  const paths = new Set([...known.paths].map((p) => p.replace(/\/+$/, '')));
  return async (naming) => {
    if (branches.has(naming.branch)) return true;
    const path = known.pathFor(naming.dirName);
    if (paths.has(path)) return true;
    return known.exists(path).catch(() => true);
  };
}

/** Whether a task offers "Follow-up…": its PR is merged, or it is archived. */
export function canFollowUp(
  task: Pick<Task, 'status'>,
  pr: Pick<PrStatus, 'state'> | null | undefined,
): boolean {
  return task.status === 'archived' || pr?.state === 'merged';
}
