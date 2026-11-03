/**
 * The branch a task merges into, for the header (`⑂ branch → base`).
 *
 * In order of authority:
 *  1. the PR's base: GitHub's answer is the one a merge uses;
 *  2. what git shows the branch stacked on (`git/stackBase.ts`): a branch can
 *     be restacked long before it has a PR -- cut from `main`, then rebased
 *     onto another task's branch -- and nothing else records that;
 *  3. the branch the worktree was cut from (`tasks.base_branch`), confirmed
 *     when the task was created.
 * A chat has no branch and so no base.
 */

import type { StackBase } from '../git/stackBase';
import type { PrStatus } from '../gh/prStatus';
import type { Task } from '../types';

export interface MergeTarget {
  base: string;
  /**
   * Where `base` came from. `older`: the branch sits on an older copy of
   * `base`, which was rewritten since -- it needs rebasing onto it.
   */
  from: 'pr' | 'stack' | 'older' | 'cut';
}

export function mergeTarget(
  task: Pick<Task, 'kind' | 'branch' | 'baseBranch'>,
  pr: PrStatus | null,
  stack: StackBase | null = null,
): MergeTarget | null {
  if (task.kind === 'chat' || task.branch === '') return null;
  if (pr && pr.baseRefName !== '') return { base: pr.baseRefName, from: 'pr' };
  if (stack) return { base: stack.base, from: stack.how === 'older' ? 'older' : 'stack' };
  return task.baseBranch !== '' ? { base: task.baseBranch, from: 'cut' } : null;
}

/**
 * What a task's work is measured against (#237): the branch it merges into,
 * by {@link mergeTarget}'s order, so the header's "→ base" and every count or
 * diff of the task's work (the Files pane, the guide, the file diff, the
 * commit counts) can never disagree. Measured on the owner's data: a task cut
 * from a parent branch whose PR was later retargeted to `main` showed "→ main"
 * in the header while the Files pane diffed against the parent -- which no
 * longer existed locally -- and said "No changes yet".
 *
 * One exception: a branch on an *older copy* of its stack parent is measured
 * against the stored base, not the parent. Its fork point with the rewritten
 * parent is behind the parent's old commits, so measuring from there would
 * count them as the task's own; the header says "needs rebase" for it.
 *
 * No branch (a chat, the main checkout's browse task) keeps the stored base,
 * empty, exactly as before: `taskBase('')` is HEAD's upstream.
 */
export function measuredBase(
  task: Pick<Task, 'kind' | 'branch' | 'baseBranch'>,
  pr: PrStatus | null,
  stack: StackBase | null = null,
): string {
  const target = mergeTarget(task, pr, stack);
  if (target === null || target.from === 'older') return task.baseBranch;
  return target.base;
}

/** The branch chip's tooltip. `cut` is the stored base, named when it differs. */
export function branchTooltip(branch: string, target: MergeTarget | null, prNumber: number | null, cut = ''): string {
  if (target === null) return `Branch ${branch}`;
  const was = cut !== '' && cut !== target.base ? ` (cut from ${cut})` : '';
  switch (target.from) {
    case 'pr':
      return `Branch ${branch}, merging into ${target.base} (PR #${prNumber ?? '?'})`;
    case 'stack':
      return `Branch ${branch}, stacked on ${target.base}, as its history shows${was}`;
    case 'older':
      return (
        `Branch ${branch}, on an older copy of ${target.base}: ${target.base} was rewritten since, ` +
        `so ${branch} needs rebasing onto it${was}`
      );
    case 'cut':
      return `Branch ${branch}, cut from ${target.base}`;
  }
}
