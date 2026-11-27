import type { Task } from '../types';

/**
 * Is there a PR for this task worth asking about? A resumed session often
 * runs on the repo's base branch, and `gh pr view main` can find some stray PR
 * opened FROM main -- attributing that to the task would be wrong.
 */
export function prLookupBranch(task: Pick<Task, 'branch' | 'baseBranch'>): string | null {
  const b = task.branch.trim();
  if (!b || b === 'HEAD' || b === task.baseBranch) return null;
  // A ref starting with "-" would read as a flag; slug.ts never makes one.
  if (b.startsWith('-')) return null;
  return b;
}
