/**
 * Whether a finished turn left work on a task's branch: commits against its
 * base, or uncommitted changes. One of the two facts behind Ready to Review
 * (`ui/taskGroups.ts`); an open PR, the other way to have work, comes from the
 * PR store and needs nothing here.
 *
 * Asked once per finished turn, never on a timer: work only appears while
 * Claude works, and a turn's end is when to look. Only for a finish the user
 * has not seen -- the list asks (`wantsWorkProbe`) -- so a launch costs one
 * look per task with news, not one per task. The count is the Create PR
 * badge's (`commitsOnBranch`, through `baseOrUpstream`), and the changes are
 * the Files pane's (`uncommittedChanges`); nothing here counts on its own.
 *
 * In memory: like a PR's checks, the answer is stale by the next turn.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Task } from '../types';
import { commitsOnBranch, uncommittedChanges } from './worktree';

type WorkTask = Pick<Task, 'id' | 'repoPath' | 'baseBranch' | 'branch' | 'worktreePath'>;

interface Entry {
  /** The finish this answer is for; a later one makes it stale. */
  finishedAt: number;
  /** Null when git could not say either way. */
  work: boolean | null;
}

const cache = new Map<number, Entry>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
/** One look at a time: a launch with several unseen finishes is not a burst of git. */
let chain: Promise<unknown> = Promise.resolve();

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

/**
 * Work, given the commit count and whether the worktree is dirty. Null only
 * when git answered neither; one answer showing work is enough.
 */
export function workFrom(commits: number | null, dirty: boolean | null): boolean | null {
  if ((commits ?? 0) > 0 || dirty === true) return true;
  if (commits === null && dirty === null) return null;
  return false;
}

async function gitProbe(task: WorkTask): Promise<boolean | null> {
  const [commits, dirty] = await Promise.all([
    task.branch ? commitsOnBranch(task.repoPath, task.baseBranch, task.branch) : Promise.resolve(null),
    uncommittedChanges(task.worktreePath).then(
      (c) => c.dirty,
      () => null,
    ),
  ]);
  return workFrom(commits, dirty);
}

let probe: (task: WorkTask) => Promise<boolean | null> = gitProbe;

/** Test seam: swap the git probe; clears the cache. */
export function setWorkProbeForTests(next: (task: WorkTask) => Promise<boolean | null>): void {
  probe = next;
  cache.clear();
  inflight.clear();
  chain = Promise.resolve();
}

/** The answer for this finish, or undefined while there is none. */
export function getReviewWork(taskId: number, finishedAt: number | null): boolean | null | undefined {
  const e = cache.get(taskId);
  return e !== undefined && e.finishedAt === finishedAt ? e.work : undefined;
}

/** Look once for this finish. Never rejects; a failure reads as "cannot say". */
export function probeReviewWork(task: WorkTask, finishedAt: number): Promise<void> {
  const key = `${task.id}:${finishedAt}`;
  if (inflight.has(key) || getReviewWork(task.id, finishedAt) !== undefined) return Promise.resolve();
  inflight.add(key);
  const run = chain.then(() =>
    probe(task)
      .catch(() => null)
      .then((work) => {
        cache.set(task.id, { finishedAt, work });
        emit();
      })
      .finally(() => inflight.delete(key)),
  );
  chain = run;
  return run;
}

/** Bumped on every answer, for a list that renders many tasks. */
export function useReviewWorkVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => version,
  );
}

/** Look at each of these finishes once. */
export function useReviewWorkProbes(wanted: { task: WorkTask; finishedAt: number }[]): void {
  const ref = useRef(wanted);
  ref.current = wanted;
  const key = wanted.map((w) => `${w.task.id}:${w.finishedAt}`).join(',');
  useEffect(() => {
    for (const w of ref.current) void probeReviewWork(w.task, w.finishedAt);
  }, [key]);
}
