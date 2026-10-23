/**
 * What is waiting in Claude Code's input queue, per session.
 *
 * Fed by the capture watcher with the queue facts it reads (see `queueFactsIn`
 * in adapter.ts, which is where the format lives). Held in memory only: a
 * queue lives for seconds to minutes, is meaningless once the session ends,
 * and is rebuilt from the transcript after a restart (the watcher replays the
 * file's history the first time it touches it), so there is nothing worth a
 * schema change.
 *
 * `dequeue` and `remove` are not the whole story: Claude Code can take several
 * entries, or drop them, with a single `dequeue` (see `QueueFact`). Two rules
 * reconcile the queue against what actually happened:
 *  - a prompt no dequeue accounts for, whose text is a typed entry's, took
 *    that entry, and the queue is FIFO, so every entry queued before it is
 *    gone too, merged or dropped;
 *  - a turn ended and, `IDLE_GRACE_MS` later, no new turn has started: typed
 *    entries queued before that end are never coming. Injected entries are
 *    left alone, since a task notification can wait out an idle session.
 */

import { isInjectedQueueText, type QueueFact } from './adapter';

export interface QueuedEntry {
  text: string;
  /** When it was queued, ms. */
  ts: number;
  /** Put there by Claude Code (a notification, a subagent), not typed. */
  injected: boolean;
}

/**
 * How long after a turn ends a typed entry may still be taken. Measured: an
 * entry waiting at a turn end was taken within 3 s every time; 30 s leaves
 * room for a slow machine without keeping a dropped entry around for long.
 */
export const IDLE_GRACE_MS = 30_000;

/** One session's queue and the turn boundaries that reconcile it. */
export interface SessionQueue {
  entries: QueuedEntry[];
  /** Latest turn start seen (a dequeue or a prompt), ms. */
  startedAt: number;
  /** The turn end no turn has started since, ms; null while a turn runs. */
  endedAt: number | null;
  /**
   * What each dequeue since the last prompt took, by text; null for a dequeue
   * on an empty queue, which took something this run never saw.
   */
  taken: (string | null)[];
}

const queues = new Map<string, SessionQueue>();
const listeners = new Set<(sessionId: string) => void>();

/**
 * The entries left at `now`: without the typed ones queued by a turn end that
 * no turn has followed for `IDLE_GRACE_MS`. Applied when the session's next
 * fact arrives, and again on every read (`queuedFor`): the band shows while
 * the session is alive, idle included, and an idle session writes no fact
 * that would clear it -- least of all while Claude Code retries a dead
 * connection.
 */
export function idleCleared(q: SessionQueue, now: number): QueuedEntry[] {
  const endedAt = q.endedAt;
  if (endedAt === null || now - endedAt < IDLE_GRACE_MS) return q.entries;
  return q.entries.filter((e) => e.injected || e.ts > endedAt);
}

/**
 * The entries left once `prompt` started a turn, given what the dequeues
 * since the last prompt `taken`.
 *
 * Normally the dequeue comes first and took the prompt's own entry, so the
 * prompt removes nothing: an entry with the same text still queued is another
 * message ("continue" sent twice), still waiting. Likewise when a dequeue took
 * something unseen (null). Only a prompt no dequeue accounts for reconciles:
 * the OLDEST typed entry with its text was taken, and since the queue is FIFO,
 * everything queued before it is gone too.
 *
 * Whole text, not a substring: a short entry ("ok", "yes") turns up inside
 * unrelated prompts. Measured on this machine: of 105 prompts after a typed
 * entry's dequeue, 88 were that entry's text exactly, and none merely held it.
 */
export function promptTaken(entries: QueuedEntry[], prompt: string, taken: readonly (string | null)[]): QueuedEntry[] {
  const text = prompt.trim();
  if (taken.some((t) => t === null || t.trim() === text)) return entries;
  const i = entries.findIndex((e) => !e.injected && e.text.trim() === text);
  return i === -1 ? entries : entries.slice(i + 1);
}

/** Apply facts in order. Pure with respect to its input `state`. */
export function applyQueueOperations(state: Map<string, SessionQueue>, facts: readonly QueueFact[]): Set<string> {
  const touched = new Set<string>();
  for (const f of facts) {
    if (f.sessionId === '') continue;
    const q = state.get(f.sessionId) ?? { entries: [], startedAt: 0, endedAt: null, taken: [] };
    const before = q.entries.length;
    // A dequeue is the queue being served, however long after a turn end (a
    // Stop hook can carry a turn on): nothing waiting is stale then.
    if (f.op !== 'turn-end' && f.op !== 'dequeue') q.entries = idleCleared(q, f.ts);
    if (f.op === 'enqueue') {
      q.entries.push({ text: f.text, ts: f.ts, injected: isInjectedQueueText(f.text) });
    } else if (f.op === 'dequeue') {
      // Oldest first. Popping an empty queue is a dequeue whose enqueue came
      // before what was read (a replay window): nothing to undo.
      q.taken.push(q.entries.shift()?.text ?? null);
    } else if (f.op === 'remove') {
      const i = q.entries.findIndex((e) => e.text === f.text);
      if (i !== -1) q.entries.splice(i, 1);
    } else if (f.op === 'prompt') {
      q.entries = promptTaken(q.entries, f.text, q.taken);
      q.taken = [];
    } else if (f.ts >= q.startedAt) {
      // A turn end stamped before the latest start was written late, after
      // the next turn's dequeue: it ends the previous turn, not this one.
      q.endedAt = f.ts;
    }
    if (f.op === 'dequeue' || f.op === 'prompt') {
      q.startedAt = Math.max(q.startedAt, f.ts);
      q.endedAt = null;
    }
    // An empty queue keeps no turn state once its dequeues have met their
    // prompt: anything queued later is stamped after every turn end it could
    // be cleared by, so nothing is lost.
    if (q.entries.length > 0 || q.taken.length > 0) state.set(f.sessionId, q);
    else state.delete(f.sessionId);
    const queueLine = f.op === 'enqueue' || f.op === 'dequeue' || f.op === 'remove';
    if (queueLine || q.entries.length !== before) touched.add(f.sessionId);
  }
  return touched;
}

/** Called by the watcher with the facts from each chunk it ingests. */
export function recordQueueOperations(facts: readonly QueueFact[]): void {
  if (facts.length === 0) return;
  for (const sid of applyQueueOperations(queues, facts)) for (const l of listeners) l(sid);
}

/**
 * Replace a session's queue with one rebuilt from `facts`, the replay of its
 * transcript's history. Used once per file per run, before new lines are
 * applied on top.
 */
export function seedQueue(sessionIds: Iterable<string>, facts: readonly QueueFact[]): void {
  const fresh = new Map<string, SessionQueue>();
  applyQueueOperations(fresh, facts);
  const touched = new Set<string>(sessionIds);
  for (const sid of fresh.keys()) touched.add(sid);
  for (const sid of touched) {
    const q = fresh.get(sid);
    if (q) queues.set(sid, q);
    else queues.delete(sid);
    for (const l of listeners) l(sid);
  }
}

/** The entries waiting for a session at `now`, oldest first. */
export function queuedFor(sessionId: string, now = Date.now()): readonly QueuedEntry[] {
  const q = queues.get(sessionId);
  return q ? idleCleared(q, now) : [];
}

/**
 * When `queuedFor` next changes with no new fact: the moment typed entries
 * left at a turn end stop counting. Null when nothing is waiting on that.
 */
export function queueSettlesAt(sessionId: string): number | null {
  const q = queues.get(sessionId);
  const endedAt = q?.endedAt ?? null;
  if (!q || endedAt === null || !q.entries.some((e) => !e.injected && e.ts <= endedAt)) return null;
  return endedAt + IDLE_GRACE_MS;
}

/** Subscribe to changes; the callback gets the session that changed. */
export function onQueueChange(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
