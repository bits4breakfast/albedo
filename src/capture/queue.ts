/**
 * What is waiting in Claude Code's input queue, per session.
 *
 * Fed by the capture watcher with the `queue-operation` lines it reads (see
 * `queueOperationsIn` in adapter.ts, which is where the format lives). Held in
 * memory only: a queue lives for seconds to minutes, is meaningless once the
 * session ends, and is rebuilt from the transcript after a restart (the
 * watcher replays the file's history the first time it touches it), so there
 * is nothing worth a schema change.
 */

import { isInjectedQueueText, type QueueOperation } from './adapter';

export interface QueuedEntry {
  text: string;
  /** When it was queued, ms. */
  ts: number;
  /** Put there by Claude Code (a notification, a subagent), not typed. */
  injected: boolean;
}

const queues = new Map<string, QueuedEntry[]>();
const listeners = new Set<(sessionId: string) => void>();

/** Apply operations in order. Pure with respect to its input `state`. */
export function applyQueueOperations(state: Map<string, QueuedEntry[]>, ops: readonly QueueOperation[]): Set<string> {
  const touched = new Set<string>();
  for (const op of ops) {
    if (op.sessionId === '') continue;
    const q = state.get(op.sessionId) ?? [];
    if (op.op === 'enqueue') {
      q.push({ text: op.text, ts: op.ts, injected: isInjectedQueueText(op.text) });
    } else if (op.op === 'dequeue') {
      // Oldest first. Popping an empty queue is a dequeue whose enqueue came
      // before what was read (a replay window): nothing to undo.
      q.shift();
    } else {
      const i = q.findIndex((e) => e.text === op.text);
      if (i !== -1) q.splice(i, 1);
    }
    if (q.length > 0) state.set(op.sessionId, q);
    else state.delete(op.sessionId);
    touched.add(op.sessionId);
  }
  return touched;
}

/** Called by the watcher with the operations from each chunk it ingests. */
export function recordQueueOperations(ops: readonly QueueOperation[]): void {
  if (ops.length === 0) return;
  for (const sid of applyQueueOperations(queues, ops)) for (const l of listeners) l(sid);
}

/**
 * Replace a session's queue with one rebuilt from `ops`, the replay of its
 * transcript's history. Used once per file per run, before new lines are
 * applied on top.
 */
export function seedQueue(sessionIds: Iterable<string>, ops: readonly QueueOperation[]): void {
  const fresh = new Map<string, QueuedEntry[]>();
  applyQueueOperations(fresh, ops);
  const touched = new Set<string>(sessionIds);
  for (const sid of fresh.keys()) touched.add(sid);
  for (const sid of touched) {
    const q = fresh.get(sid);
    if (q) queues.set(sid, q);
    else queues.delete(sid);
    for (const l of listeners) l(sid);
  }
}

/** The entries waiting for a session, oldest first. */
export function queuedFor(sessionId: string): readonly QueuedEntry[] {
  return queues.get(sessionId) ?? [];
}

/** Subscribe to changes; the callback gets the session that changed. */
export function onQueueChange(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
