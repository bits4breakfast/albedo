/**
 * The prompts behind the files pane's git buttons.
 *
 * Albedo does not run these operations itself: committing needs a message,
 * a rebase can conflict, and a rejected push needs a decision. Claude Code
 * handles all three, so the buttons hand it a prompt -- through the composer,
 * where it can be read and edited before it is sent.
 */

import type { Task } from '../types';

type GitTask = Pick<Task, 'branch' | 'baseBranch'>;

/** Commit what is outstanding, then push the branch. */
export function pushPrompt(task: GitTask): string {
  return [
    `Push branch \`${task.branch}\` to origin.`,
    '',
    '- If there are uncommitted changes, commit them first: group them into sensible commits with clear messages. Ask me if something looks like it should not be committed.',
    '- Set the upstream if the branch has none.',
    '- If the push is rejected because this branch was rebased, push with `--force-with-lease`. If it is rejected because the remote has commits this branch does not, stop and tell me.',
  ].join('\n');
}

export interface SquashOptions {
  /** Fold uncommitted changes into the squashed commit, rather than set them aside. */
  includeUncommitted: boolean;
  /** Push the result when it is done. */
  push: boolean;
  /** Commits on the branch as Albedo sees them: a cross-check for Claude, not an instruction. */
  commitCount: number;
}

/** Rebase onto the latest base and squash the branch to one commit. */
export function squashRebasePrompt(task: GitTask, opts: SquashOptions): string {
  const base = task.baseBranch;
  const n = opts.commitCount;
  return [
    `Squash this branch into one commit and rebase it onto the latest \`${base}\`.`,
    '',
    `- Fetch first, and rebase onto \`origin/${base}\` if it exists, otherwise onto \`${base}\`.`,
    `- I count ${n} commit${n === 1 ? '' : 's'} on this branch. If you see a different number, stop and tell me before changing anything.`,
    opts.includeUncommitted
      ? '- Include the uncommitted changes in the squashed commit.'
      : '- Leave uncommitted changes out of it: stash them before you start and restore them at the end.',
    '- Write one commit message describing the whole change, not a list of the steps it took.',
    '- If a conflict resolution is not obvious, stop and ask me.',
    opts.push
      ? `- When it is done, push \`${task.branch}\` with \`--force-with-lease\` (set the upstream if it has none).`
      : '- Do not push.',
  ].join('\n');
}

/** Open a pull request for the branch, written from everything on it. */
export function createPrPrompt(task: GitTask): string {
  return [
    `Open a pull request for \`${task.branch}\` into \`${task.baseBranch}\`.`,
    '',
    '- If there are uncommitted changes, ask me whether they belong in it before you commit anything.',
    '- Push the branch first if the remote does not have all of it (set the upstream if it has none).',
    `- Write the title and description from every commit on the branch and the diff against \`${task.baseBranch}\`, not just the latest commit: what changed and why, and how it was checked. Follow the repository's PR template if it has one.`,
    `- Create it with \`gh pr create --base ${task.baseBranch}\`, and give me the URL.`,
  ].join('\n');
}

/** What the git bar's main button offers: the next thing this branch needs. */
export type NextStep = 'push' | 'create-pr' | 'open-pr' | 'none';

export function nextStep(s: {
  /** Uncommitted files. */
  dirty: number;
  /** Commits the remote does not have; every commit when there is no upstream. */
  unpushed: number;
  /** Commits on the branch against its base. */
  commits: number;
  /** A PR exists for the branch (any state). */
  hasPr: boolean;
  /** The branch can have a PR at all: it is not the base itself. */
  prable: boolean;
}): NextStep {
  if (s.dirty > 0 || s.unpushed > 0) return 'push';
  if (s.hasPr) return 'open-pr';
  if (s.prable && s.commits > 0) return 'create-pr';
  return 'none';
}

/** A rebase onto its own base is meaningless: the task runs on the base branch itself. */
export function canSquashRebase(task: GitTask): boolean {
  return task.branch.length > 0 && task.branch !== task.baseBranch;
}
