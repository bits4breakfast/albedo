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
    if (f.sessionId === '' || f.op === 'turn-stop' || f.op === 'turn-step') continue;
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

/**
 * Where a session's turns stand, from the same facts, for the outbox
 * (src/ui/transcript/turn.ts); the queue itself does not use it.
 *
 * In FILE order, not by timestamp: a start holds (`running`) until the next
 * end after it in the file. Claude Code writes a queued entry's `dequeue`
 * just before the end lines of the turn it was folded into, stamped a few
 * ms after them; by time that read as a new turn that never came.
 *
 * - A start: a `prompt` Claude Code did not inject, or a `turn-step` (its
 *   main-thread API call, or an assistant line mid-turn).
 * - An end: a `turn-end` or `turn-stop`.
 * - Pending (`pendingAt`): a `dequeue`, or a prompt Claude Code injected
 *   (`isInjectedQueueText`). A turn about to start -- or not: measured over
 *   this machine's transcripts, a notification's dequeue and user line were
 *   followed by a turn within 5 s 102 times and by nothing, until the
 *   person typed, 47 times (once for 47 minutes); its user line is written
 *   after the `turn_duration` of the turn before. turn.ts counts it for a
 *   grace only, and the turn's own API call, within milliseconds when it
 *   comes, takes over as a start.
 */
export interface TurnMarks {
  running: boolean;
  /** The latest start, ms. */
  startedAt: number | null;
  /** The latest end, ms. */
  endedAt: number | null;
  /** The latest dequeue or injected prompt, ms. */
  pendingAt: number | null;
}

const turns = new Map<string, TurnMarks>();

/** Apply facts to `state`, in file order. Returns the sessions whose marks moved. */
export function applyTurnFacts(state: Map<string, TurnMarks>, facts: readonly QueueFact[]): Set<string> {
  const touched = new Set<string>();
  for (const f of facts) {
    if (f.sessionId === '') continue;
    const pending = f.op === 'dequeue' || (f.op === 'prompt' && isInjectedQueueText(f.text));
    const start = f.op === 'turn-step' || (f.op === 'prompt' && !pending);
    const end = f.op === 'turn-end' || f.op === 'turn-stop';
    if (!start && !end && !pending) continue;
    const m = state.get(f.sessionId) ?? { running: false, startedAt: null, endedAt: null, pendingAt: null };
    const latest = (at: number | null) => Math.max(at ?? f.ts, f.ts);
    const next: TurnMarks = pending
      ? { ...m, pendingAt: latest(m.pendingAt) }
      : start
        ? { ...m, running: true, startedAt: latest(m.startedAt) }
        : { ...m, running: false, endedAt: latest(m.endedAt) };
    if (
      next.running !== m.running ||
      next.startedAt !== m.startedAt ||
      next.endedAt !== m.endedAt ||
      next.pendingAt !== m.pendingAt
    ) {
      state.set(f.sessionId, next);
      touched.add(f.sessionId);
    }
  }
  return touched;
}

/** The session's turn marks, or null when no turn fact has been read. */
export function turnMarksFor(sessionId: string): TurnMarks | null {
  return turns.get(sessionId) ?? null;
}

/** Called by the watcher with the facts from each chunk it ingests. */
export function recordQueueOperations(facts: readonly QueueFact[]): void {
  if (facts.length === 0) return;
  const touched = applyQueueOperations(queues, facts);
  for (const sid of applyTurnFacts(turns, facts)) touched.add(sid);
  for (const sid of touched) for (const l of listeners) l(sid);
}

/**
 * Replace a session's queue with one rebuilt from `facts`, the replay of its
 * transcript's history. Used once per file per run, before new lines are
 * applied on top.
 */
export function seedQueue(sessionIds: Iterable<string>, facts: readonly QueueFact[]): void {
  const fresh = new Map<string, SessionQueue>();
  applyQueueOperations(fresh, facts);
  const freshTurns = new Map<string, TurnMarks>();
  applyTurnFacts(freshTurns, facts);
  const touched = new Set<string>(sessionIds);
  for (const sid of fresh.keys()) touched.add(sid);
  for (const sid of freshTurns.keys()) touched.add(sid);
  for (const sid of touched) {
    const q = fresh.get(sid);
    if (q) queues.set(sid, q);
    else queues.delete(sid);
    const m = freshTurns.get(sid);
    if (m) turns.set(sid, m);
    else turns.delete(sid);
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

/** Subscribe to changes; the callback gets the session whose queue or turn marks changed. */
export function onQueueChange(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
