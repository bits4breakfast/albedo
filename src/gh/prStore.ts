/**
 * In-memory PR status per task, and the schedule that keeps it fresh.
 *
 * Deliberately NOT in SQLite: a PR's checks are stale within minutes, so a
 * persisted copy would be wrong on every launch and right only by accident.
 * The cost of starting cold is one `gh` call per visible task.
 *
 * Three refresh triggers, one rule:
 *   - every {@link POLL_MS} for the tasks on screen,
 *   - on window focus -- coming back from the browser is exactly when the
 *     owner wants to know whether CI went green,
 *   - on demand, when a task is selected.
 * Whatever the trigger, a task never has more than one `gh` call in flight,
 * and a result younger than {@link MIN_AGE_MS} is reused rather than refetched.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Task } from '../types';
import { fetchPrStatus } from './gh';
import type { PrStatus } from './prStatus';

export const POLL_MS = 60_000;
/** Focus and selection churn; this keeps a burst of them to one fetch. */
export const MIN_AGE_MS = 15_000;
/** gh is a network round trip each; ten tasks should not be ten at once. */
const MAX_CONCURRENT = 3;

type PrTask = Pick<Task, 'id' | 'branch' | 'baseBranch' | 'worktreePath' | 'repoPath' | 'status'>;

interface Entry {
  /** Null is a real answer: "no PR for this branch" (or gh unavailable). */
  pr: PrStatus | null;
  /** The branch it was fetched for; a different branch makes it stale. */
  branch: string;
  fetchedAt: number;
}

const cache = new Map<number, Entry>();
const inflight = new Map<number, Promise<void>>();
const listeners = new Set<() => void>();

let fetcher: (task: PrTask) => Promise<PrStatus | null> = fetchPrStatus;
let now: () => number = () => Date.now();

/** Test seam: swap the fetch and the clock; clears the cache. */
export function setPrFetcherForTests(
  next: (task: PrTask) => Promise<PrStatus | null>,
  clock?: () => number,
): void {
  fetcher = next;
  if (clock) now = clock;
  cache.clear();
  inflight.clear();
  queue.length = 0;
  running = 0;
}

/** Bumped on every change, so a list can re-render on one subscription. */
let version = 0;

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

// --- a tiny concurrency gate ----------------------------------------------

let running = 0;
const queue: Array<() => void> = [];

function gate<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running += 1;
      job()
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          queue.shift()?.();
        });
    };
    if (running < MAX_CONCURRENT) start();
    else queue.push(start);
  });
}

// --- public API ------------------------------------------------------------

/** The cached answer: a PR, null for "none", undefined for "not asked yet". */
export function getPrStatus(taskId: number): PrStatus | null | undefined {
  return cache.get(taskId)?.pr;
}

export function subscribePrStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Refresh one task. Resolves when the fetch (or the one already running for
 * it) settles. Never rejects: a failed fetch keeps the previous answer.
 */
export function refreshPrStatus(task: PrTask, opts: { force?: boolean } = {}): Promise<void> {
  const already = inflight.get(task.id);
  if (already) return already;
  const prev = cache.get(task.id);
  const fresh = prev && prev.branch === task.branch && now() - prev.fetchedAt < MIN_AGE_MS;
  if (fresh && !opts.force) return Promise.resolve();

  const p = gate(() => fetcher(task))
    .then((pr) => {
      cache.set(task.id, { pr, branch: task.branch, fetchedAt: now() });
      emit();
    })
    .catch((err) => {
      // fetchPrStatus does not throw by contract; this is for a fetcher that
      // does. Keep what we had -- a flicker to "no PR" would be a lie.
      console.warn('[gh] pr status failed', err);
    })
    .finally(() => {
      inflight.delete(task.id);
    });
  inflight.set(task.id, p);
  return p;
}

/** Drop a task's entry, e.g. after it is deleted. */
export function forgetPrStatus(taskId: number): void {
  if (cache.delete(taskId)) emit();
}

// --- React -----------------------------------------------------------------

/**
 * One task's PR status. Asking IS the on-demand trigger: mounting this for a
 * task (selecting it) refreshes it unless the answer is younger than
 * {@link MIN_AGE_MS}.
 */
export function usePrStatus(task: PrTask | null): PrStatus | null {
  const id = task?.id ?? null;
  const pr = useSyncExternalStore(subscribePrStatus, () => (id === null ? null : (getPrStatus(id) ?? null)));
  const live = task !== null && task.status !== 'archived';
  useEffect(() => {
    if (task && live) void refreshPrStatus(task);
    // Keyed on identity and branch: a title edit is not a reason to refetch.
  }, [id, task?.branch, live]);
  return live ? pr : null;
}

/** Subscribe to the whole cache, for a list that shows many tasks. */
export function usePrStatusVersion(): number {
  return useSyncExternalStore(subscribePrStatus, () => version);
}

/**
 * Keep the given tasks fresh: now, every {@link POLL_MS}, and whenever the
 * window regains focus. Archived tasks are skipped -- their PR is history.
 */
export function usePrPolling(tasks: PrTask[]): void {
  const ref = useRef(tasks);
  ref.current = tasks;
  // Re-arm only when the SET of tasks changes, not on every status tick.
  const key = tasks
    .filter((t) => t.status !== 'archived')
    .map((t) => `${t.id}:${t.branch}`)
    .join(',');

  useEffect(() => {
    const sweep = () => {
      for (const t of ref.current) {
        if (t.status !== 'archived') void refreshPrStatus(t);
      }
    };
    sweep();
    // A hidden window has nobody reading the badge; focus catches it up.
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
