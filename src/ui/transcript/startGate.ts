/**
 * Tasks whose `claude` has not started yet (#439). Albedo runs `claude`
 * through an interactive login shell, and anything the user's rc files run
 * first -- an update prompt, a login -- reads the pty's input before
 * `claude` does: Albedo's first paste answered oh-my-zsh's update question
 * and arrived as "[200~text", unsent (#433). So nothing is typed into a new
 * pty until Claude Code reports it is up: the first `SessionStart` hook
 * event of that process (CLAUDE.md, the hook channel; the same signal the
 * workspace-trust check waits for).
 *
 * Two writers. The terminal (Terminal.tsx), which alone knows a process,
 * shuts it from the spawn of a pty that has the hooks until a `SessionStart`
 * of that process (`noteSessionStarted`), or until the pty ends. A pty
 * spawned without the hooks never waits here: no event would ever come.
 * And Send Anyway on the warning (StartWait.tsx) opens it by hand, for a
 * Claude Code whose hooks never run (`sendAnyway`): only the wait it was
 * shown for, and the task is remembered for the rest of the run, so the
 * next wait warns at once.
 *
 * While a task waits, every send is held (`mustHold`, send.ts) and the
 * outbox's release waits (outboxRelease.ts); once it is up the held
 * messages go, in order.
 *
 * Its own module, importing nothing of Albedo's, like deliveryGate.ts: send.ts
 * reads it, the terminal writes it, and the many tests that stand in for the
 * terminal need nothing new.
 */

import { useSyncExternalStore } from 'react';

/** Per task: when the pty still waiting for its first SessionStart was spawned, ms. */
const waitingSince = new Map<number, number>();
const listeners = new Set<(taskId: number) => void>();

/**
 * The task's pty, spawned at `since`, is waiting for Claude Code to start;
 * null when it has started, or there is no such pty any more.
 */
export function setAwaitingStart(taskId: number, since: number | null): void {
  const was = waitingSince.get(taskId) ?? null;
  if (was === since) return;
  if (since === null) waitingSince.delete(taskId);
  else waitingSince.set(taskId, since);
  for (const cb of [...listeners]) {
    try {
      cb(taskId);
    } catch (err) {
      console.warn('[startGate] a listener failed', err);
    }
  }
}

/**
 * Tasks where Send Anyway opened a wait no SessionStart had ended, this run:
 * their hooks may never fire, so the next wait warns at once. Forgotten when
 * a later process of the task does report its start.
 */
const startedByHand = new Set<number>();

/** This process of the task reported its start: the wait ends, and its hooks are known to fire. */
export function noteSessionStarted(taskId: number): void {
  startedByHand.delete(taskId);
  setAwaitingStart(taskId, null);
}

/**
 * Send Anyway: end the wait that began at `since` -- only that one: a
 * respawn since the warning was drawn has its own wait, not shown yet --
 * and remember the task. False when that wait is no longer the task's.
 */
export function sendAnyway(taskId: number, since: number): boolean {
  if (!clearAwaitingStartIf(taskId, since)) return false;
  startedByHand.add(taskId);
  return true;
}

/** End the task's wait only if it is still the one that began at `since`. True when it did. */
export function clearAwaitingStartIf(taskId: number, since: number): boolean {
  if (waitingSince.get(taskId) !== since) return false;
  setAwaitingStart(taskId, null);
  return true;
}

/** Send Anyway was needed for this task this run, and no start has been reported since. */
export function startNeededByHand(taskId: number): boolean {
  return startedByHand.has(taskId);
}

/** The task's pty is up and `claude` has not reported its start yet: nothing is typed into it. */
export function awaitingStart(taskId: number): boolean {
  return waitingSince.has(taskId);
}

/** When the pty that is waiting was spawned, ms; null when none waits. */
export function awaitingStartSince(taskId: number): number | null {
  return waitingSince.get(taskId) ?? null;
}

/** Called with the task whose wait began or ended. */
export function onAwaitingStartChange(cb: (taskId: number) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** {@link awaitingStartSince}, re-rendering when it changes. */
export function useAwaitingStartSince(taskId: number | null): number | null {
  return useSyncExternalStore(
    onAwaitingStartChange,
    () => (taskId === null ? null : awaitingStartSince(taskId)),
    () => null,
  );
}

/** {@link awaitingStart}, re-rendering when it changes. */
export function useAwaitingStart(taskId: number | null): boolean {
  return useAwaitingStartSince(taskId) !== null;
}

/**
 * Hook stamps are whole seconds (HOOK_SCRIPT's `date +%s`), so a SessionStart
 * from this process can carry a time up to a second before the spawn was
 * recorded.
 */
export const START_STAMP_SLACK_MS = 1_000;

/** Whether a SessionStart stamped `at` belongs to the process spawned at `spawnedAt`. */
export function startIsThisProcess(at: number, spawnedAt: number): boolean {
  return at >= spawnedAt - START_STAMP_SLACK_MS;
}

/** Test seam. */
export function __resetStartGate(): void {
  waitingSince.clear();
  startedByHand.clear();
}
