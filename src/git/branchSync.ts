/**
 * Keep a task's stored branch in step with what its worktree has checked out.
 *
 * `tasks.branch` is written once, when the task is created. A task running in
 * the main checkout outlives that: the owner switches branches under it, and
 * every reader of the stored value goes quietly wrong -- the row and the files
 * pane name the old branch, and the PR lookup, seeing `branch === baseBranch`,
 * decides there is nothing to look up. Found with a task recorded on `main`
 * while its checkout sat on `build-script`, with PR #7 open and no badge.
 *
 * Git is the authority; the column is a cache of it. A detached HEAD or a
 * failed read changes nothing: there is no branch to record, and the last
 * known one is a better answer than none.
 */

import { useEffect, useRef } from 'react';
import type { Task } from '../types';
import { updateTask } from '../db';
import { git } from './worktree';

type SyncTask = Pick<Task, 'id' | 'branch' | 'worktreePath' | 'status' | 'createdBranch'>;

/** Same cadence as the PR poll, which is what reads the result. */
const POLL_MS = 60_000;

/**
 * What to write, given the branch git reports. Null when nothing changes.
 *
 * `createdBranch` drops to false on a switch: it is what lets archive offer to
 * delete the branch, and Albedo did not create the one now checked out.
 * Switching back to Albedo's own branch leaves it false -- the branch is then
 * kept on archive, which is the safe way to be wrong.
 */
export function branchPatch(task: SyncTask, current: string | null): Partial<Task> | null {
  const b = current?.trim() ?? '';
  if (b.length === 0 || b === task.branch) return null;
  return { branch: b, createdBranch: task.createdBranch === true ? false : task.createdBranch };
}

/** The checked-out branch, or null on a detached HEAD or any failure. */
export async function checkedOutBranch(worktreePath: string): Promise<string | null> {
  try {
    const r = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktreePath);
    return r.code === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null; // worktree gone, git missing: keep what is stored
  }
}

const inflight = new Set<number>();

export async function syncTaskBranch(task: SyncTask): Promise<void> {
  if (task.status === 'archived' || !task.worktreePath || inflight.has(task.id)) return;
  inflight.add(task.id);
  try {
    const patch = branchPatch(task, await checkedOutBranch(task.worktreePath));
    if (patch) await updateTask(task.id, patch);
  } catch (err) {
    console.warn('[git] branch sync failed', err);
  } finally {
    inflight.delete(task.id);
  }
}

/** Sync the given tasks now, every {@link POLL_MS}, and on window focus. */
export function useBranchSync(tasks: SyncTask[]): void {
  const ref = useRef(tasks);
  ref.current = tasks;
  const key = tasks
    .filter((t) => t.status !== 'archived')
    .map((t) => t.id)
    .join(',');

  useEffect(() => {
    const sweep = () => {
      for (const t of ref.current) void syncTaskBranch(t);
    };
    sweep();
    const timer = setInterval(() => {
      if (!document.hidden) sweep();
    }, POLL_MS);
    window.addEventListener('focus', sweep);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', sweep);
    };
  }, [key]);
}
