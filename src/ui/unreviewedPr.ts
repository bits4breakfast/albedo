/**
 * When "Create PR without Review…" is offered (#464): your own work task, gh
 * has said it has no PR, the branch has work on it, and Create PR still waits
 * on the review (guide/gate.ts). One rule for both of the task's ⋯ menus
 * (#331), read through `useTaskMenuFacts`.
 */

import { useEffect, useState } from 'react';
import type { Task } from '../types';
import { getPrStatus } from '../gh/prStore';
import { prLookupBranch } from '../gh/gh';
import { branchWorkNow } from '../git/reviewWork';
import { gateOf, gatePasses, gatedTask, useGateVersion } from '../guide/gate';
import { useGuideStoreVersion } from '../guide/store';

export function useUnreviewedPrOffered(task: Task | null): boolean {
  useGuideStoreVersion();
  useGateVersion();
  const held =
    !!task &&
    gatedTask(task) &&
    task.status !== 'archived' &&
    prLookupBranch(task) !== null &&
    getPrStatus(task.id) === null &&
    !gatePasses(gateOf(task.id));
  return useBranchWork(held ? task : null) === true;
}

/** The last answer per task, shared: a menu opened elsewhere starts from it. */
const lastWork = new Map<number, boolean | null>();

/**
 * Whether the task's branch has work now -- commits against its base or
 * uncommitted changes (reviewWork.ts) -- asked when the task or its last
 * activity changes, never while a turn runs. Starts from the last answer for
 * the task, so a menu does not grow an item after it opened; null while none.
 */
function useBranchWork(task: Task | null): boolean | null {
  const id = task?.id ?? null;
  const [answer, setAnswer] = useState<{ taskId: number; work: boolean | null } | null>(null);
  // Not while a turn runs: every transcript write is activity. Its end is.
  const at = task?.status === 'running' ? 'running' : String(task?.lastActivityAt ?? '');
  const key = task ? `${task.id}\n${task.worktreePath}\n${task.branch}\n${at}` : '';
  useEffect(() => {
    if (!task) return;
    let live = true;
    const taskId = task.id;
    void branchWorkNow(task).then((work) => {
      lastWork.set(taskId, work);
      if (live) setAnswer({ taskId, work });
    });
    return () => {
      live = false;
    };
    // `key` carries the task, its folder, branch and activity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (id === null) return null;
  // The last answer stands while the next is asked: no flicker in the menu.
  return answer?.taskId === id ? answer.work : (lastWork.get(id) ?? null);
}
