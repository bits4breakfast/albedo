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
 * Set by the terminal (Terminal.tsx), which alone knows a process: from the
 * spawn of a pty that has the hooks until a `SessionStart` stamped no
 * earlier than that spawn, or until the pty ends. A pty spawned without the
 * hooks never waits here: no event would ever come.
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
}
