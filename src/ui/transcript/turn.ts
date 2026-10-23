/**
 * Whether a turn is running in a task's session: while one is, anything Albedo
 * sends waits in its outbox (outbox.ts) instead of Claude Code's queue, and
 * goes once the turn has ended (#61).
 *
 * Why, measured on Claude Code 2.1.308 driven in a pty (October 2026):
 *  - Every dialog -- a question, a permission, plan approval -- opens inside a
 *    turn, and Albedo learns of it only once the hook event has been read.
 *    Anything typed in that gap goes into the dialog: the paste is dropped and
 *    the Enter picks the highlighted option (a question was answered "Red"; on
 *    a permission prompt that is "Yes").
 *  - What is already in Claude Code's queue when a dialog opens stays there:
 *    it was never taken while a dialog waited (10 to 70 s). It goes with the
 *    dialog's outcome instead, every entry at once: folded into the answer's
 *    tool result, or, if the dialog is cancelled, sent as the next prompts --
 *    which reads as the message having cancelled the question.
 * No turn can show a dialog before it starts, so between turns is the one time
 * typing cannot land in one, and Claude Code cannot be asked to give back what
 * it holds. A turn cannot be known in advance to stay free of dialogs, so the
 * hold is for every running turn.
 *
 * The turn comes from transcript facts, not from the task's status: starts
 * against turn ends in file order (`turnMarksFor`, kept by capture/queue.ts
 * from adapter.ts's facts), Claude Code's queue, and Albedo's own submits.
 * The status's recency windows guess, both ways: an interrupted turn read
 * `running` for 90 s, and a turn thinking for 90 s read `idle`.
 * Nothing here reads the pty or a hook event.
 */

import { useSyncExternalStore } from 'react';
import { onQueueChange, queuedFor, queueSettlesAt, turnMarksFor, type QueuedEntry } from '../../capture/queue';
import { ptyLiveSince } from '../Terminal';

/**
 * How long a submit with no transcript fact since counts as a turn starting,
 * and a notification Claude Code queued itself as one about to start. Either
 * reaches the transcript within a second or two; past this it is taken to
 * have started nothing, so a held message is not kept forever.
 */
export const START_GRACE_MS = 30_000;

/**
 * The entries of Claude Code's queue that this process can still take: the
 * ones you typed (not the ones Claude Code queued itself) since its pty was
 * spawned, and none without a live pty.
 *
 * - Only while the session's pty is alive (`liveSince` not null), whatever the
 *   status. Status is derived from the transcript and lags the queue --
 *   between one turn ending and the next starting, and the whole time Claude
 *   Code retries a dead connection, it reads `idle` with entries waiting.
 * - Only entries queued since that pty was spawned. Claude Code's queue lives
 *   in its process's memory, so a new or resumed `claude` starts empty; the
 *   transcript, which the queue is rebuilt from, still lists what the last
 *   process never took, and no turn end will ever clear it.
 *
 * The Queued band shows these, and `turnRunning` counts them.
 */
export function shownQueue(entries: readonly QueuedEntry[], liveSince: number | null): QueuedEntry[] {
  if (liveSince === null) return [];
  return entries.filter((e) => !e.injected && e.ts >= liveSince);
}

export interface TurnFacts {
  /** When the task's live pty was spawned; null with none. */
  liveSince: number | null;
  /** The transcript's marks say a turn is running (capture/queue.ts, `TurnMarks`). */
  running: boolean;
  /** Their latest start, ms. */
  startedAt: number | null;
  /** Their latest turn end, ms. */
  endedAt: number | null;
  /** Albedo's last submit to the session, ms. */
  submittedAt: number | null;
  /** Typed entries waiting in Claude Code's queue (`shownQueue`). */
  queued: number;
  /**
   * The newest sign of a turn about to start that may not come, ms: an entry
   * Claude Code queued itself (a finished agent's notification), or the
   * marks' `pendingAt` (a dequeue, or such a message's user line).
   */
  injectedAt: number | null;
  now: number;
}

/**
 * Whether a turn is running, or about to, in a live session:
 *  - the transcript's marks say so, from a start this pty wrote (an older
 *    one is a process that is gone: a resumed session starts between turns);
 *  - Claude Code holds typed entries, which it takes as a turn within
 *    seconds of the last one ending;
 *  - Claude Code queued, dequeued, or wrote a message it gave itself (a
 *    notification) under `START_GRACE_MS` ago, since the last turn end: it
 *    often starts a turn with it, sometimes not, and that turn's API call
 *    then marks it running;
 *  - Albedo submitted after the latest turn end, under `START_GRACE_MS` ago:
 *    the prompt it started is not on disk yet.
 */
export function turnRunning(f: TurnFacts): boolean {
  if (f.liveSince === null) return false;
  if (f.running && f.startedAt !== null && f.startedAt >= f.liveSince) return true;
  if (f.queued > 0) return true;
  return turnSettlesAt(f) !== null;
}

/**
 * When `turnRunning` over these facts can change with nothing new noted: the
 * last grace that makes a turn "about to start" running out. Null when none
 * applies.
 */
export function turnSettlesAt(f: TurnFacts): number | null {
  if (f.liveSince === null) return null;
  const since = f.liveSince;
  const ended = f.endedAt ?? -Infinity;
  const ends = [f.injectedAt, f.submittedAt]
    // The same millisecond as the turn end counts as after it: holding is
    // the side to err on.
    .filter((at): at is number => at !== null && at >= since && at >= ended)
    .map((at) => at + START_GRACE_MS)
    .filter((end) => end > f.now);
  return ends.length > 0 ? Math.max(...ends) : null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const sessions = new Map<number, string | null>();
const submitted = new Map<number, number>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<(taskId: number) => void>();
let offQueue: (() => void) | null = null;

function factsFor(taskId: number, now: number): TurnFacts {
  const sessionId = sessions.get(taskId) ?? null;
  const liveSince = ptyLiveSince(taskId);
  const marks = sessionId ? turnMarksFor(sessionId) : null;
  const entries = sessionId ? queuedFor(sessionId, now) : [];
  let injectedAt: number | null = marks?.pendingAt ?? null;
  for (const e of entries) {
    if (e.injected && liveSince !== null && e.ts >= liveSince) injectedAt = Math.max(injectedAt ?? e.ts, e.ts);
  }
  return {
    liveSince,
    running: marks?.running ?? false,
    startedAt: marks?.startedAt ?? null,
    endedAt: marks?.endedAt ?? null,
    submittedAt: submitted.get(taskId) ?? null,
    queued: shownQueue(entries, liveSince).length,
    injectedAt,
    now,
  };
}

/** Whether a turn is running in the task's session now (see the module note). */
export function isTurnRunning(taskId: number, now = Date.now()): boolean {
  return turnRunning(factsFor(taskId, now));
}

function changed(taskId: number): void {
  // Re-ask when the answer would change on its own: a grace, or Claude
  // Code's entries left at a turn end stop counting.
  const t = timers.get(taskId);
  if (t !== undefined) clearTimeout(t);
  timers.delete(taskId);
  const now = Date.now();
  const sessionId = sessions.get(taskId) ?? null;
  const edges = [turnSettlesAt(factsFor(taskId, now)), sessionId ? queueSettlesAt(sessionId) : null].filter(
    (at): at is number => at !== null && at > now,
  );
  if (edges.length > 0) {
    timers.set(
      taskId,
      setTimeout(() => {
        timers.delete(taskId);
        changed(taskId);
      }, Math.min(...edges) - now + 1),
    );
  }
  for (const cb of [...listeners]) cb(taskId);
}

/** Which session each task is on: useTasks.ts, on every change to the list. */
export function noteTaskSessions(tasks: readonly { id: number; sessionId: string | null }[]): void {
  for (const t of tasks) {
    if (sessions.has(t.id) && sessions.get(t.id) === t.sessionId) continue;
    sessions.set(t.id, t.sessionId);
    changed(t.id);
  }
}

/** Albedo submitted text to the task's session (send.ts). */
export function noteSubmitted(taskId: number, at = Date.now()): void {
  submitted.set(taskId, at);
  changed(taskId);
}

/** Called with the task whose turn facts changed; the turn may or may not have. */
export function onTurnChange(cb: (taskId: number) => void): () => void {
  listeners.add(cb);
  offQueue ??= onQueueChange((sid) => {
    for (const [id, s] of sessions) if (s === sid) changed(id);
  });
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && offQueue !== null) {
      offQueue();
      offQueue = null;
    }
  };
}

/** `isTurnRunning`, re-rendering when it may have changed. */
export function useTurnRunning(taskId: number | null): boolean {
  return useSyncExternalStore(
    onTurnChange,
    () => (taskId === null ? false : isTurnRunning(taskId)),
    () => false,
  );
}

/** Test seam. */
export function __resetTurns(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  sessions.clear();
  submitted.clear();
  listeners.clear();
  offQueue?.();
  offQueue = null;
}
