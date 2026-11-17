/**
 * Whether a message Albedo typed into a session reached Claude Code (#433).
 *
 * A write to the pty succeeding says only that the bytes left: Claude Code
 * can still fail to take them. Owner-reported, cause unconfirmed: the first
 * message into a freshly started `claude` sat in its input box as
 * "[200~…", unsent, and the next send was glued onto it. Nothing in the
 * terminal may be read to notice that (CLAUDE.md), so the transcript decides:
 * a message Claude Code took is a `user` row, or, sent while it was busy, an
 * entry in its queue or the dequeue that took it (the pane's "Sending" echo
 * uses the same rules: `echoLanded` and `echoIsQueued` in commandEcho.ts).
 *
 *  - Every message delivered through `submitLocked` (send.ts) -- the message
 *    box, the outbox's release, Send Now, Try Again, the prompt buttons -- is
 *    expected in the transcript within `DELIVERY_TIMEOUT_MS`.
 *  - If it is not there by then, it was not delivered: it goes back to the
 *    head of the task's outbox, marked so (`holdNotDelivered`). The Queued
 *    band shows it with "Not delivered — check the terminal", and since
 *    something is held, every later send is held behind it (`mustHold`) and
 *    no release passes it, until the person chooses Send, Edit or Remove.
 *    Nothing is glued onto what may still sit in Claude Code's input box.
 *  - It is watched for a while longer (`LATE_LANDING_MS`): if it does turn up
 *    -- a slow start, or Enter pressed in the terminal -- and the person has
 *    not acted on it, it leaves the outbox again. Only a row carrying its
 *    text counts then: a prompt typed in the terminal meanwhile is not it.
 *  - A slash command is not watched. Some write nothing for minutes
 *    (`/compact`), some land in another session (`/clear`), some open a menu
 *    in the terminal (`/remote-control`); their echo (commandEcho.ts) already
 *    says when nothing came back.
 *  - When the transcript cannot be read, nothing is said: unknown is not
 *    "not delivered".
 *
 * The timeout is under turn.ts's `START_GRACE_MS`: until that grace runs out
 * a submit holds every later send, so the message is back at the head of the
 * outbox before anything held could be released behind it.
 *
 * Nothing here reads the pty or a hook event.
 */

import { onCaptureUpdate } from '../../capture';
import { onQueueChange, queuedFor, turnMarksFor } from '../../capture/queue';
import { mainRowsSince } from '../../db';
import type { Message } from '../../types';
import { ptyLiveSince } from '../Terminal';
import { echoIsQueued, echoLanded } from './commandEcho';
import { heldFor, holdNotDelivered, onOutboxChange, removeHeld } from './outbox';
import { isSlashCommand, onSessionSubmit, type SendSource } from './send';
import { onTurnChange, sessionOfTask } from './turn';

/**
 * How long a message may take to show in the transcript. Claude Code writes
 * the prompt's row as it takes it, and the watcher reads it within a second
 * or two; this leaves room for a session still starting or a slow machine,
 * and stays under `START_GRACE_MS` (see the module note).
 */
export const DELIVERY_TIMEOUT_MS = 20_000;
/** How long a message said to be undelivered is still looked for. */
export const LATE_LANDING_MS = 10 * 60_000;
/** What the band and the message box say about it. */
export const NOT_DELIVERED = 'Not delivered — check the terminal';
/** A row stamped in the same instant as the send still counts (as the echo's). */
const SLACK_MS = 1_000;
/** How much of the text's first line a late row must carry. */
const MATCH_CHARS = 60;

export interface Expected {
  taskId: number;
  text: string;
  /** When the write began, ms. */
  at: number;
  /** When the write finished, ms. */
  sentAt: number;
  /** Its entry in the outbox once it was said to be undelivered; null before. */
  heldId: string | null;
}

/**
 * Whether a row written after the message was said to be undelivered is
 * that message: a prompt row whose body carries the start of its first line.
 * Stricter than `landed`, since by then the person may be typing in the
 * terminal themselves; a miss only leaves the entry for them to remove.
 */
export function landedLate(e: Pick<Expected, 'at' | 'text'>, rows: readonly Message[]): boolean {
  const first = e.text.trim().split('\n')[0]?.trim().slice(0, MATCH_CHARS) ?? '';
  if (first.length === 0) return false;
  return rows.some((m) => echoLanded(e, [m]) && (m.body ?? '').includes(first));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const expected = new Map<number, Expected[]>();
const timers = new Map<Expected, ReturnType<typeof setTimeout>>();
const listeners = new Set<(e: Expected) => void>();

/** Called with each message said to be undelivered, as it is. */
export function onNotDelivered(cb: (e: Expected) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** The messages still watched for the task, oldest first. */
export function expectedFor(taskId: number): readonly Expected[] {
  return expected.get(taskId) ?? [];
}

function drop(e: Expected): void {
  const t = timers.get(e);
  if (t !== undefined) clearTimeout(t);
  timers.delete(e);
  const list = (expected.get(e.taskId) ?? []).filter((x) => x !== e);
  if (list.length > 0) expected.set(e.taskId, list);
  else expected.delete(e.taskId);
}

/** Its entry is still in the outbox as undelivered: the person has not acted on it. */
function stillHeld(e: Expected): boolean {
  return e.heldId !== null && heldFor(e.taskId).some((h) => h.id === e.heldId && h.notDelivered === true);
}

/** The rows written since `e`'s send, or null when they cannot be read. */
async function rowsSince(e: Expected): Promise<Message[] | null> {
  try {
    return await mainRowsSince(e.taskId, sessionOfTask(e.taskId), e.at - SLACK_MS);
  } catch {
    return null;
  }
}

/**
 * Claude Code's queue has it: an entry from no earlier than the send, or a
 * dequeue since (`pendingAt`). Sent into a running turn, an entry can be
 * queued and taken in one read of the file, folded into the turn with no
 * user row of its own; the dequeue is what is left of it.
 */
function queuedSince(e: Expected): boolean {
  const sessionId = sessionOfTask(e.taskId);
  if (sessionId === null) return false;
  if (echoIsQueued(e, queuedFor(sessionId), ptyLiveSince(e.taskId))) return true;
  const pendingAt = turnMarksFor(sessionId)?.pendingAt ?? null;
  return pendingAt !== null && pendingAt >= e.at - SLACK_MS;
}

/** Tasks whose rows are being read, and those to read again once that is done. */
const checking = new Set<number>();
const recheck = new Set<number>();

/** Read what the transcript has for the task's watched messages, and settle the ones there. */
async function check(taskId: number): Promise<void> {
  if (!expected.has(taskId)) return;
  if (checking.has(taskId)) {
    recheck.add(taskId);
    return;
  }
  checking.add(taskId);
  try {
    for (const e of [...expectedFor(taskId)]) {
      if (e.heldId === null) {
        if (queuedSince(e)) {
          drop(e);
          continue;
        }
        const rows = await rowsSince(e);
        // Said to be undelivered while this read was out: the late rule decides now.
        if (e.heldId !== null || !expectedFor(taskId).includes(e)) continue;
        if (rows !== null && echoLanded(e, rows)) drop(e);
      } else {
        const rows = await rowsSince(e);
        if (rows === null || !landedLate(e, rows) || !expectedFor(taskId).includes(e)) continue;
        drop(e);
        if (stillHeld(e)) removeHeld(taskId, e.heldId);
      }
    }
  } finally {
    checking.delete(taskId);
    if (recheck.delete(taskId)) void check(taskId);
  }
}

/** The timeout: one last look, then it was not delivered. */
async function decide(e: Expected): Promise<void> {
  timers.delete(e);
  if (!expectedFor(e.taskId).includes(e)) return;
  const rows = await rowsSince(e);
  if (!expectedFor(e.taskId).includes(e)) return;
  // A prompt row or a queue entry since the send (the echo's rules:
  // time, not text -- Claude Code records a pasted image path as
  // `[Image #1]`). Unreadable is unknown, and unknown says nothing.
  if (rows === null || queuedSince(e) || echoLanded(e, rows)) {
    drop(e);
    return;
  }
  const held = holdNotDelivered(e.taskId, e.text);
  if (held === null) {
    drop(e);
    return;
  }
  e.heldId = held.id;
  console.warn(`[send] task ${e.taskId}: a message written to the session never reached its transcript; held as not delivered`);
  timers.set(
    e,
    setTimeout(() => drop(e), Math.max(0, e.at + LATE_LANDING_MS - Date.now())),
  );
  for (const cb of [...listeners]) {
    try {
      cb(e);
    } catch (err) {
      console.warn('[send] a not-delivered listener failed', err);
    }
  }
}

function submitted(taskId: number, text: string, _from?: SendSource, startedAt?: number): void {
  if (isSlashCommand(text)) return;
  const now = Date.now();
  const e: Expected = { taskId, text, at: startedAt ?? now, sentAt: now, heldId: null };
  expected.set(taskId, [...expectedFor(taskId), e]);
  timers.set(
    e,
    setTimeout(() => void decide(e), DELIVERY_TIMEOUT_MS),
  );
}

let offs: (() => void)[] | null = null;

/**
 * Watch every message sent from now on, for the rest of the run. Started by
 * the transcript pane's first mount and never stopped: the pane is keyed by
 * task, and a message sent just before a task switch is still watched.
 */
export function startDeliveryWatch(): void {
  if (offs !== null) return;
  offs = [
    onSessionSubmit(submitted),
    // Only the task's own session (or one not known yet).
    onCaptureUpdate((u) => {
      for (const taskId of expected.keys()) {
        const sessionId = sessionOfTask(taskId);
        if (sessionId === null || u?.sessionId === sessionId) void check(taskId);
      }
    }),
    onQueueChange((sid) => {
      for (const taskId of expected.keys()) if (sessionOfTask(taskId) === sid) void check(taskId);
    }),
    // The task moved to another session: its rows may have been read before they were linked.
    onTurnChange((taskId) => {
      if (expected.has(taskId)) void check(taskId);
    }),
    // Send, Edit or Remove on the entry: the person has it now.
    onOutboxChange((taskId) => {
      for (const e of [...expectedFor(taskId)]) if (e.heldId !== null && !stillHeld(e)) drop(e);
    }),
  ];
}

/** Test seam. */
export function __resetDelivery(): void {
  for (const off of offs ?? []) off();
  offs = null;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  expected.clear();
  checking.clear();
  recheck.clear();
  listeners.clear();
}
