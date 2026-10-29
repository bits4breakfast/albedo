/**
 * The branch a task merges into, for the header (`⑂ branch → base`).
 *
 * The PR's base when there is a PR: GitHub's answer is the one a merge uses,
 * and it follows a restack -- a task cut from `main` and later stacked on
 * another task's branch. Before there is a PR, the branch the worktree was cut
 * from (`tasks.base_branch`), which is all Albedo knows. A chat has no branch
 * and so no base.
 */

import type { PrStatus } from '../gh/prStatus';
import type { Task } from '../types';

export interface MergeTarget {
  base: string;
  /** Where `base` came from: the PR, or the cut. The tooltip says which. */
  from: 'pr' | 'cut';
}

export function mergeTarget(task: Pick<Task, 'kind' | 'branch' | 'baseBranch'>, pr: PrStatus | null): MergeTarget | null {
  if (task.kind === 'chat' || task.branch === '') return null;
  if (pr && pr.baseRefName !== '') return { base: pr.baseRefName, from: 'pr' };
  return task.baseBranch !== '' ? { base: task.baseBranch, from: 'cut' } : null;
}

/** The branch chip's tooltip. */
export function branchTooltip(branch: string, target: MergeTarget | null, prNumber: number | null): string {
  if (target === null) return `Branch ${branch}`;
  return target.from === 'pr'
    ? `Branch ${branch}, merging into ${target.base} (PR #${prNumber ?? '?'})`
    : `Branch ${branch}, cut from ${target.base}`;
}
