/**
 * The base a task's work is measured against, live (#237): the PR's base once
 * gh answers, else what git shows the branch stacked on, else the stored base
 * (`measuredBase` in mergeTarget.ts). The header's branch chip, the Files
 * pane, the guide, the file diff and the Create PR count all read it here, so
 * none of them can measure against a branch the header does not show.
 */

import { useEffect, useState } from 'react';
import { getPrStatus, usePrStatus } from '../gh/prStore';
import { detectStackBase, type StackBase } from '../git/stackBase';
import type { Task } from '../types';
import { measuredBase, mergeTarget, type MergeTarget } from './mergeTarget';

/** Same cadence as the PR poll and the branch sync. */
const STACK_POLL_MS = 60_000;

type StackTask = Pick<Task, 'id' | 'kind' | 'status' | 'branch' | 'baseBranch' | 'worktreePath'>;
/** What the PR store and the stack check both need. */
type BaseTask = StackTask & Pick<Task, 'repoPath'>;

const inflight = new Map<string, Promise<StackBase | null>>();

function stackKey(task: StackTask): string {
  return `${task.id}\n${task.worktreePath}\n${task.branch}\n${task.baseBranch}`;
}

/**
 * One stack check at a time per task: the chip, the Files pane and the guide
 * mount together and ask together, and share the one git look in flight.
 */
function lookStack(task: StackTask): Promise<StackBase | null> {
  const key = stackKey(task);
  const running = inflight.get(key);
  if (running) return running;
  const answer = detectStackBase(task.worktreePath, task.branch, task.baseBranch)
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, answer);
  return answer;
}

function hasBranch(task: StackTask | null): task is StackTask {
  return task !== null && task.kind !== 'chat' && task.status !== 'archived' && task.branch !== '';
}

/**
 * What git shows the task's branch stacked on, when that is not its stored
 * base. Checked on mount, on window focus, and every minute while the window
 * is visible: a restack happens in the terminal, unannounced.
 */
export function useStackBase(task: StackTask | null): StackBase | null {
  const key = task ? stackKey(task) : '';
  const [found, setFound] = useState<{ key: string; value: StackBase | null } | null>(null);
  const checks = hasBranch(task);
  useEffect(() => {
    if (!checks || !task) return;
    let live = true;
    const run = () => {
      if (document.hidden) return;
      void lookStack(task).then((value) => {
        if (live) setFound({ key, value });
      });
    };
    run();
    const timer = window.setInterval(run, STACK_POLL_MS);
    window.addEventListener('focus', run);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', run);
    };
    // `key` carries everything the check reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, checks]);
  return found?.key === key ? found.value : null;
}

export interface MeasuredBase {
  /** The base name to hand the git helpers: '' when the task has no branch. */
  base: string;
  /** What the header shows, and where it came from. */
  target: MergeTarget | null;
  /**
   * gh has answered for the PR (or there is no branch to ask about). Until it
   * has, `base` may still move to the PR's: a pane says "can't find the base"
   * only once it is settled, so a stored base that is gone does not flash.
   */
  settled: boolean;
}

export function useMeasuredBase(task: BaseTask | null): MeasuredBase {
  const branchTask = task !== null && hasBranch(task) ? task : null;
  const pr = usePrStatus(branchTask);
  const stack = useStackBase(branchTask);
  if (task === null) return { base: '', target: null, settled: true };
  const settled = branchTask === null || getPrStatus(branchTask.id) !== undefined;
  return { base: measuredBase(task, pr, stack), target: mergeTarget(task, pr, stack), settled };
}
