/**
 * Tasks with a message written to the pty that the transcript has not shown
 * yet (#433, delivery.ts). While one is unconfirmed, nothing else is typed
 * into that task (`mustHold`, the outbox's release): if Claude Code did not
 * take it, it still sits in its input box, and the next paste would be glued
 * onto it. turn.ts's grace after a submit holds sends too, but a turn that
 * ends on its own within it voids that grace; this does not.
 *
 * Its own module, importing nothing of Albedo's, so send.ts can read it
 * while delivery.ts (which listens to send.ts) writes it.
 */

import { useSyncExternalStore } from 'react';

const unconfirmed = new Map<number, number>();
const listeners = new Set<(taskId: number) => void>();

/** How many of the task's messages are unconfirmed (delivery.ts). */
export function setUnconfirmed(taskId: number, count: number): void {
  const was = unconfirmed.get(taskId) ?? 0;
  if (count > 0) unconfirmed.set(taskId, count);
  else unconfirmed.delete(taskId);
  if ((was > 0) !== (count > 0)) for (const cb of [...listeners]) cb(taskId);
}

/** A message to the task is written and not yet seen in the transcript. */
export function awaitingDelivery(taskId: number): boolean {
  return unconfirmed.has(taskId);
}

/** Called with the task whose `awaitingDelivery` changed. */
export function onAwaitingDeliveryChange(cb: (taskId: number) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** {@link awaitingDelivery}, re-rendering when it changes. */
export function useAwaitingDelivery(taskId: number | null): boolean {
  return useSyncExternalStore(
    onAwaitingDeliveryChange,
    () => (taskId === null ? false : awaitingDelivery(taskId)),
    () => false,
  );
}

/** Test seam. */
export function __resetDeliveryGate(): void {
  unconfirmed.clear();
}
