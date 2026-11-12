/**
 * The base a task's work is measured against, live (#237): the PR's base once
 * gh answers, else what git shows the branch stacked on, else the stored base
 * (`measuredBase` in mergeTarget.ts). The header's branch chip, the Files
 * pane, the guide, the file diff and the Create PR count all read it here, so
 * none of them can measure against a branch the header does not show.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { getPrStatus, usePrStatus } from '../gh/prStore';
import type { PrStatus } from '../gh/prStatus';
import { detectStackBase, type StackBase } from '../git/stackBase';
import type { Task } from '../types';
import { measuredBase, mergeTarget, type MergeTarget } from './mergeTarget';

/** Same cadence as the PR poll and the branch sync. */
export const STACK_POLL_MS = 60_000;

type StackTask = Pick<Task, 'id' | 'kind' | 'status' | 'branch' | 'baseBranch' | 'worktreePath'>;
/** What the PR store and the stack check both need. */
type BaseTask = StackTask & Pick<Task, 'repoPath'>;

function stackKey(task: StackTask): string {
  return `${task.id}\n${task.worktreePath}\n${task.branch}\n${task.baseBranch}`;
}

// --- one store for every reader (#365) --------------------------------------
//
// The chip, the Files pane, the guide, the file diff, the Create PR count and
// the shell each ask about the selected task. They share one entry per task
// (and branch, base and folder), one minute timer and one focus listener for
// all of them, instead of a timer and a listener each.

interface StackEntry {
  task: StackTask;
  /** What the last look found; undefined until one has answered. */
  value: StackBase | null | undefined;
  /** Readers mounted for it. The entry goes with the last one. */
  users: number;
  /** The look in flight, shared by everyone who asks meanwhile. */
  running: Promise<void> | null;
}

const entries = new Map<string, StackEntry>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function same(a: StackBase | null | undefined, b: StackBase | null): boolean {
  if (a === undefined) return false;
  if (a === null || b === null) return a === b;
  return a.base === b.base && a.how === b.how;
}

/**
 * One stack check at a time per entry: the chip, the Files pane and the guide
 * mount together and ask together, and share the one git look in flight.
 */
function look(key: string): void {
  const entry = entries.get(key);
  if (!entry || entry.running || document.hidden) return;
  const task = entry.task;
  entry.running = detectStackBase(task.worktreePath, task.branch, task.baseBranch)
    .catch(() => null)
    .then((value) => {
      entry.running = null;
      // Gone meanwhile (every reader unmounted): nothing to tell.
      if (entries.get(key) !== entry || same(entry.value, value)) return;
      entry.value = value;
      emit();
    });
}

function lookAll(): void {
  for (const key of entries.keys()) look(key);
}

function acquire(key: string, task: StackTask): void {
  let entry = entries.get(key);
  if (!entry) {
    entry = { task, value: undefined, users: 0, running: null };
    entries.set(key, entry);
  }
  entry.users += 1;
  if (timer === null) {
    timer = setInterval(lookAll, STACK_POLL_MS);
    window.addEventListener('focus', lookAll);
  }
  // Every mount asks, as each reader did on its own: a pane opened later
  // still gets a look of its own time, shared with any already in flight.
  look(key);
}

function release(key: string): void {
  const entry = entries.get(key);
  if (entry) {
    entry.users -= 1;
    if (entry.users <= 0) entries.delete(key);
  }
  if (entries.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
    window.removeEventListener('focus', lookAll);
  }
}

/** Tests: how many stack timers and entries are live. */
export function stackStoreStateForTests(): { timers: number; entries: number } {
  return { timers: timer === null ? 0 : 1, entries: entries.size };
}

function hasBranch(task: StackTask | null): task is StackTask {
  return task !== null && task.kind !== 'chat' && task.status !== 'archived' && task.branch !== '';
}

/**
 * What git shows the task's branch stacked on, when that is not its stored
 * base. Checked on mount, on window focus, and every minute while the window
 * is visible: a restack happens in the terminal, unannounced.
 *
 * Not checked at all while the task's PR names its base (`pr`): the PR's base
 * outranks a stack (`mergeTarget`), so the answer could not change anything.
 * Pass `undefined` for a reader that does not know the PR.
 */
export function useStackBase(task: StackTask | null, pr?: PrStatus | null): StackBase | null {
  const prNamesBase = !!pr && pr.baseRefName !== '';
  const checks = hasBranch(task) && !prNamesBase;
  const key = checks && task ? stackKey(task) : '';
  useEffect(() => {
    if (key === '' || !task) return;
    acquire(key, task);
    return () => release(key);
    // `key` carries everything the check reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const value = useSyncExternalStore(subscribe, () => (key === '' ? undefined : entries.get(key)?.value));
  return value ?? null;
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
  const stack = useStackBase(branchTask, pr);
  if (task === null) return { base: '', target: null, settled: true };
  const settled = branchTask === null || getPrStatus(branchTask.id) !== undefined;
  return { base: measuredBase(task, pr, stack), target: mergeTarget(task, pr, stack), settled };
}
