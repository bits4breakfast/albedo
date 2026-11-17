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
 * A row Claude Code wrote itself (a task notification, another session's
 * message) is never it.
 *
 *  - Every message delivered through `submitLocked` (send.ts) -- the message
 *    box, the outbox's release, Send Now, Try Again, the prompt buttons -- is
 *    expected in the transcript within `DELIVERY_TIMEOUT_MS`, or
 *    `FIRST_SEND_TIMEOUT_MS` for the first one into a newly spawned pty,
 *    which may still be starting.
 *  - Until it shows, nothing else is typed into that task (deliveryGate.ts):
 *    sends are held, the release waits.
 *  - Missing from the database is not missing from the transcript while
 *    ingest is behind on the session's file (`ingestBehind`): the decision
 *    waits for it, and past `BEHIND_MAX_MS` it is unknown, and unknown says
 *    nothing. So does a database that cannot be read.
 *  - Not there, with ingest caught up: it was not delivered. It goes back to
 *    the head of the task's outbox, marked so (`holdNotDelivered`), with the
 *    code comments it carried, which are unmarked as sent. The Queued band
 *    shows it with "Not delivered — check the terminal", and since something
 *    is held, every later send is held behind it (`mustHold`) and no release
 *    passes it, until the person chooses Send, Edit or Remove.
 *  - It is watched for a while longer (`LATE_LANDING_MS`): if it does turn up
 *    -- Enter pressed in the terminal -- and the person has not touched it, it
 *    leaves the outbox again and its comments are marked sent. Only a row
 *    whose text is the message's (`sameText`) counts then: a prompt typed in
 *    the terminal meanwhile is not it. Opening it for editing, or editing
 *    it, ends the watch: it is the person's from then on.
 *  - A slash command is not watched. Some write nothing for minutes
 *    (`/compact`), some land in another session (`/clear`), some open a menu
 *    in the terminal (`/remote-control`); their echo (commandEcho.ts) already
 *    says when nothing came back.
 *
 * Nothing here reads the pty or a hook event.
 */

import { ingestBehind, isInjectedQueueText, onCaptureUpdate } from '../../capture';
import { onQueueChange, queuedFor, turnMarksFor } from '../../capture/queue';
import { mainRowsSince } from '../../db';
import { unmarkCommentsSent } from '../../db/comments';
import type { Message } from '../../types';
import { ptyLiveSince } from '../Terminal';
import { markCarriedSent } from './codeComments';
import { commandEchoLanded, echoIsQueued, echoLanded } from './commandEcho';
import { setUnconfirmed } from './deliveryGate';
import { heldFor, holdNotDelivered, isEditingHeld, onEditingChange, onOutboxChange, removeHeld, type HeldMessage } from './outbox';
import { isSlashCommand, onSessionSubmit, type SendSource } from './send';
import { onTurnChange, sessionOfTask } from './turn';

/**
 * How long a message may take to show in the transcript. Claude Code writes
 * the prompt's row as it takes it, and the watcher reads it within a second
 * or two; this leaves room for a slow machine.
 */
export const DELIVERY_TIMEOUT_MS = 20_000;
/** The same for the first message into a newly spawned pty: a resume can take a while to start. */
export const FIRST_SEND_TIMEOUT_MS = 60_000;
/** While ingest is behind, how often the decision is tried again. */
export const BEHIND_RETRY_MS = 5_000;
/** Still behind this long after the send: unknown, and nothing is said. */
export const BEHIND_MAX_MS = 3 * 60_000;
/** How long a message said to be undelivered is still looked for. */
export const LATE_LANDING_MS = 10 * 60_000;
/** What the band and the message box say about it. */
export const NOT_DELIVERED = 'Not delivered — check the terminal';
/** The same for one held before Albedo restarted: the terminal's input box is a new one since. */
export const NOT_DELIVERED_BEFORE_RESTART = 'Not delivered (before the restart) — check the terminal';
/** A row stamped in the same instant as the send still counts (as the echo's). */
const SLACK_MS = 1_000;
/** The late check reads this many rows at most: user and system rows of the main thread. */
const LATE_ROWS = 5_000;
/** A message at least this long may match a row by this much of its start (a long body is stored cut). */
const LONG_CHARS = 200;
/** When this run of Albedo began: a not-delivered entry held before it is from a previous run. */
const RUN_STARTED_AT = Date.now();

/** The band's note for a held message that was not delivered. */
export function notDeliveredNote(h: Pick<HeldMessage, 'heldAt'>, runStartedAt = RUN_STARTED_AT): string {
  return h.heldAt < runStartedAt ? NOT_DELIVERED_BEFORE_RESTART : NOT_DELIVERED;
}

export interface Expected {
  taskId: number;
  text: string;
  /** When the write began, ms. */
  at: number;
  /** When the write finished, ms. */
  sentAt: number;
  /** The code comments the text carries (marked sent by whoever sent it). */
  commentIds: readonly number[];
  /** Its entry in the outbox once it was said to be undelivered; null before. */
  heldId: string | null;
}

/**
 * The text without what a paste Claude Code did not parse leaves around it:
 * the bracketed-paste markers, with or without their ESC.
 */
export function bareText(text: string): string {
  // Line endings as submitPty sends them; trailing whitespace goes with the trim.
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/^(?:\x1b)?\[200~/, '')
    .replace(/(?:\x1b)?\[201~$/, '')
    .trim();
}

/**
 * Whether a row's body is the message: the same text, markers aside. A long
 * message may match by its first `LONG_CHARS`, since a long body is stored
 * cut; a short one only whole -- "ok" is inside too many rows.
 */
export function sameText(body: string | null, text: string): boolean {
  const b = bareText(body ?? '');
  const t = bareText(text);
  if (t.length === 0) return false;
  if (b === t) return true;
  return t.length >= LONG_CHARS && b.length >= LONG_CHARS && b.slice(0, LONG_CHARS) === t.slice(0, LONG_CHARS);
}

/** Rows Claude Code wrote itself (a task notification, another session's message) are nobody's send. */
function typed(rows: readonly Message[]): Message[] {
  return rows.filter((m) => !isInjectedQueueText(m.body ?? ''));
}

/** Whether the rows show the message, within its timeout: by time, as the echo. */
export function landedRows(e: Pick<Expected, 'at'>, rows: readonly Message[]): boolean {
  return echoLanded(e, typed(rows));
}

/**
 * Whether a row written after the message was said to be undelivered is
 * that message: a prompt row since the send whose text is the message's.
 * Stricter than `landedRows`, since by then the person may be typing in the
 * terminal themselves; a miss only leaves the entry for them to remove.
 */
export function landedLate(e: Pick<Expected, 'at' | 'text'>, rows: readonly Message[]): boolean {
  return typed(rows).some((m) => echoLanded(e, [m]) && sameText(m.body, e.text));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const expected = new Map<number, Expected[]>();
const timers = new Map<Expected, ReturnType<typeof setTimeout>>();
const listeners = new Set<(e: Expected) => void>();
const lateListeners = new Set<(e: Expected) => void>();
/** The pty each task's last watched send went into, by when it was spawned. */
const spawnSeen = new Map<number, number>();

/** Called with each message said to be undelivered, as it is. */
export function onNotDelivered(cb: (e: Expected) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** Called with each message said to be undelivered that turned up after all, and left the outbox. */
export function onDeliveredLate(cb: (e: Expected) => void): () => void {
  lateListeners.add(cb);
  return () => void lateListeners.delete(cb);
}

/** The messages still watched for the task, oldest first. */
export function expectedFor(taskId: number): readonly Expected[] {
  return expected.get(taskId) ?? [];
}

function watched(e: Expected): boolean {
  return expectedFor(e.taskId).includes(e);
}

/** Tell the gate how many of the task's messages are still unconfirmed. */
function syncGate(taskId: number): void {
  setUnconfirmed(taskId, expectedFor(taskId).filter((x) => x.heldId === null).length);
}

function drop(e: Expected): void {
  const t = timers.get(e);
  if (t !== undefined) clearTimeout(t);
  timers.delete(e);
  const list = expectedFor(e.taskId).filter((x) => x !== e);
  if (list.length > 0) expected.set(e.taskId, list);
  else expected.delete(e.taskId);
  syncGate(e.taskId);
}

/**
 * Its entry is still in the outbox exactly as it was put there: not sent
 * again, not edited, not open for editing. Otherwise the person has it.
 */
function stillHeld(e: Expected): boolean {
  if (e.heldId === null || isEditingHeld(e.heldId)) return false;
  return heldFor(e.taskId).some((h) => h.id === e.heldId && h.notDelivered === true && h.text === e.text);
}

/** The rows written since `e`'s send, or null when they cannot be read. */
async function rowsSince(e: Expected, limit?: number): Promise<Message[] | null> {
  try {
    return await mainRowsSince(e.taskId, sessionOfTask(e.taskId), e.at - SLACK_MS, limit);
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

/** Ingest may not have read the session's latest lines: unknown counts as behind. */
async function behind(e: Expected): Promise<boolean> {
  const sessionId = sessionOfTask(e.taskId);
  if (sessionId === null) return true;
  try {
    return await ingestBehind(sessionId);
  } catch {
    return true;
  }
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
        if (e.heldId !== null || !watched(e)) continue;
        if (rows !== null && landedRows(e, rows)) drop(e);
      } else {
        if (!stillHeld(e)) {
          drop(e);
          continue;
        }
        const rows = await rowsSince(e, LATE_ROWS);
        if (rows === null || !landedLate(e, rows) || !watched(e) || !stillHeld(e)) continue;
        drop(e);
        deliveredLate(e);
      }
    }
  } finally {
    checking.delete(taskId);
    if (recheck.delete(taskId)) void check(taskId);
  }
}

/** It turned up after all: out of the outbox, and its comments are sent. */
function deliveredLate(e: Expected): void {
  if (e.heldId !== null) removeHeld(e.taskId, e.heldId);
  if (e.commentIds.length > 0) {
    markCarriedSent(e.taskId, e.commentIds, '[send] a message arrived late, but its code comments could not be marked as sent');
  }
  for (const cb of [...lateListeners]) {
    try {
      cb(e);
    } catch (err) {
      console.warn('[send] a late-delivery listener failed', err);
    }
  }
}

/** The deadline: one last look, then -- with ingest caught up -- it was not delivered. */
async function decide(e: Expected): Promise<void> {
  timers.delete(e);
  try {
    if (!watched(e) || e.heldId !== null) return;
    if (queuedSince(e)) {
      drop(e);
      return;
    }
    const rows = await rowsSince(e);
    if (!watched(e) || e.heldId !== null) return;
    // Unreadable is unknown, and unknown says nothing.
    if (rows === null || queuedSince(e) || landedRows(e, rows)) {
      drop(e);
      return;
    }
    const late = await behind(e);
    if (!watched(e) || e.heldId !== null) return;
    if (late) {
      if (Date.now() - e.at < BEHIND_MAX_MS) timers.set(e, setTimeout(() => decideLogged(e), BEHIND_RETRY_MS));
      else drop(e);
      return;
    }
    notDelivered(e);
  } finally {
    // Whatever threw on the way, a message left undecided with nothing to
    // decide it again would hold the task's sends for good.
    if (watched(e) && e.heldId === null && !timers.has(e)) drop(e);
  }
}

/** `decide`, from a timer: what throws is said, never left unhandled. */
function decideLogged(e: Expected): void {
  decide(e).catch((err: unknown) => console.warn('[send] could not decide whether a message was delivered', err));
}

function notDelivered(e: Expected): void {
  const now = Date.now();
  let held: HeldMessage | null = null;
  try {
    held = holdNotDelivered(e.taskId, e.text, now, e.commentIds);
  } catch (err) {
    // An outbox listener threw after the entry was stored: it is there all the same.
    console.warn('[send] an outbox listener failed while a message was held as not delivered', err);
    held = heldFor(e.taskId).find((h) => h.notDelivered === true && h.heldAt === now && h.text === e.text) ?? null;
  }
  try {
    if (held === null) {
      drop(e);
      return;
    }
    e.heldId = held.id;
    timers.set(
      e,
      setTimeout(() => drop(e), Math.max(0, e.at + LATE_LANDING_MS - Date.now())),
    );
    console.warn(`[send] task ${e.taskId}: a message written to the session never reached its transcript; held as not delivered`);
    // Its comments go with it, unsent, until it is delivered (outboxRelease.ts marks them then).
    if (e.commentIds.length > 0) {
      unmarkCommentsSent(e.taskId, e.commentIds).catch((err: unknown) =>
        console.warn('[send] a message was not delivered, and its code comments could not be unmarked', err),
      );
    }
    // A button's prompt echoes as a command (commandEcho.ts); the band has it now.
    commandEchoLanded(e.taskId, e.at);
    for (const cb of [...listeners]) {
      try {
        cb(e);
      } catch (err) {
        console.warn('[send] a not-delivered listener failed', err);
      }
    }
  } finally {
    // Decided, whatever threw above: the gate is the held entry's now.
    syncGate(e.taskId);
  }
}

function submitted(
  taskId: number,
  text: string,
  _from?: SendSource,
  startedAt?: number,
  commentIds: readonly number[] = [],
): void {
  if (isSlashCommand(text)) return;
  const now = Date.now();
  // The first send into this pty: it may still be starting.
  const spawned = ptyLiveSince(taskId);
  const first = spawned !== null && spawnSeen.get(taskId) !== spawned;
  if (spawned !== null) spawnSeen.set(taskId, spawned);
  const e: Expected = { taskId, text, at: startedAt ?? now, sentAt: now, commentIds: [...commentIds], heldId: null };
  expected.set(taskId, [...expectedFor(taskId), e]);
  syncGate(taskId);
  timers.set(
    e,
    setTimeout(() => decideLogged(e), first ? FIRST_SEND_TIMEOUT_MS : DELIVERY_TIMEOUT_MS),
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
  const settled = (taskId: number) => {
    for (const e of [...expectedFor(taskId)]) if (e.heldId !== null && !stillHeld(e)) drop(e);
  };
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
    // Send, Edit, Remove, or opened for editing: the person has it now.
    onOutboxChange(settled),
    onEditingChange(settled),
  ];
}

/** Test seam: the task's pty spawned at `since` has had a send already. */
export function __noteSpawnSeen(taskId: number, since: number): void {
  spawnSeen.set(taskId, since);
}

/** Test seam. */
export function __resetDelivery(): void {
  for (const off of offs ?? []) off();
  offs = null;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  for (const taskId of expected.keys()) setUnconfirmed(taskId, 0);
  expected.clear();
  spawnSeen.clear();
  checking.clear();
  recheck.clear();
  listeners.clear();
  lateListeners.clear();
}
