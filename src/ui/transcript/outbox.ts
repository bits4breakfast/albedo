/**
 * Messages Albedo holds back from Claude Code, per task, until they can go.
 *
 * Sent while the API is unreachable, a message typed into the terminal would
 * sit in Claude Code's queue while it retries, and could be dropped when it
 * gives up. Held here instead, Claude Code does not have it yet, so neither
 * side retries it or loses it: it waits in the Queued band, where it can be
 * edited or removed, and `releaseHeld` sends it, oldest first, through the
 * same locked send a normal send uses (send.ts; outboxRelease.ts decides when).
 *
 * A message sent while a turn is running waits here too, for the turn to end:
 * in Claude Code's queue it would go with the outcome of any dialog the turn
 * opens, and nothing can take it back from there (turn.ts).
 *
 * What Claude Code already holds is never here and never resent: only the
 * send gateway (send.ts) adds entries, and only instead of sending.
 *
 * Memory is the store and localStorage its copy, written on every change (an
 * entry is something you meant to send, so there is no write delay to lose
 * it in). It outlives a task switch and a restart, and leaves only when it is
 * sent, removed, or its task is archived or deleted. Each entry holds what
 * Claude Code will receive, paste placeholders already filled.
 */

import { useSyncExternalStore } from 'react';
import { KEYS, readPersisted, writePersisted } from '../persisted';
import type { Codec } from '../persisted';

export interface HeldMessage {
  /** Stable within the store, for edit and remove. */
  id: string;
  text: string;
  /** When it was held, ms. */
  heldAt: number;
  /**
   * Being written to the pty now. Stored, so a crash mid-send is known on
   * the next load: the entry then comes back as `maybeSent`.
   */
  sending?: boolean;
  /**
   * Was being sent when the app stopped: Claude Code may have it. Never sent
   * by a release; the person chooses Send (`sendAnyway`) or Remove.
   */
  maybeSent?: boolean;
  /**
   * Review comments the text carries, marked sent once it is delivered. Kept
   * with the message, so a task switch or a restart in between still marks them.
   */
  commentIds?: readonly number[];
}

export type Outbox = ReadonlyMap<number, readonly HeldMessage[]>;

const NONE: readonly HeldMessage[] = [];

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

function isHeld(value: unknown): value is HeldMessage {
  if (typeof value !== 'object' || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.id === 'string' &&
    typeof h.text === 'string' &&
    typeof h.heldAt === 'number' &&
    (h.sending === undefined || typeof h.sending === 'boolean') &&
    (h.maybeSent === undefined || typeof h.maybeSent === 'boolean') &&
    (h.commentIds === undefined || (Array.isArray(h.commentIds) && h.commentIds.every((c) => typeof c === 'number')))
  );
}

/**
 * The outbox as a new run finds it: an entry still marked `sending` was cut
 * off mid-send and may or may not have reached Claude Code, so it waits for
 * the person instead of being sent again or dropped.
 */
export function afterCrash(outbox: Outbox): Outbox {
  if (![...outbox.values()].some((held) => held.some((h) => h.sending))) return outbox;
  const next = new Map<number, readonly HeldMessage[]>();
  for (const [id, held] of outbox) {
    next.set(
      id,
      held.map(({ sending, ...h }) => (sending ? { ...h, maybeSent: true } : h)),
    );
  }
  return next;
}

/**
 * A JSON object of task id -> held messages, oldest first. A malformed entry
 * is dropped, not fatal; an empty outbox removes the key.
 */
export const outboxCodec: Codec<Outbox> = {
  decode: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const map = new Map<number, HeldMessage[]>();
    for (const [key, value] of Object.entries(parsed)) {
      const id = Number(key);
      if (!Number.isInteger(id) || !Array.isArray(value)) continue;
      const held = value.filter(isHeld);
      if (held.length > 0) map.set(id, held);
    }
    return map;
  },
  encode: (outbox) => (outbox.size === 0 ? null : JSON.stringify(Object.fromEntries(outbox))),
};

/** `outbox` with the task's list replaced; an empty list removes the task. */
export function withHeld(outbox: Outbox, taskId: number, held: readonly HeldMessage[]): Outbox {
  const next = new Map(outbox);
  if (held.length === 0) next.delete(taskId);
  else next.set(taskId, held);
  return next;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let outbox: Outbox | null = null;
let seq = 0;
/** Entries open for editing in the band: a release stops before them. */
const editing = new Set<string>();
/** Tasks with a release under way, so two triggers cannot send one entry twice. */
const releasing = new Set<number>();
/** Tasks whose last release ended on a failed write. */
const failing = new Set<number>();
const listeners = new Set<(taskId: number) => void>();
const releaseListeners = new Set<(taskId: number, held: HeldMessage) => void>();

function current(): Outbox {
  if (outbox === null) {
    const stored = readPersisted<Outbox>(KEYS.composerOutbox, outboxCodec, new Map());
    outbox = afterCrash(stored);
    if (outbox !== stored) writePersisted(KEYS.composerOutbox, outboxCodec, outbox);
  }
  return outbox;
}

function commit(taskId: number, held: readonly HeldMessage[]): void {
  outbox = withHeld(current(), taskId, held);
  writePersisted(KEYS.composerOutbox, outboxCodec, outbox);
  for (const cb of [...listeners]) cb(taskId);
}

/** The task's held messages, oldest first. */
export function heldFor(taskId: number): readonly HeldMessage[] {
  return current().get(taskId) ?? NONE;
}

/** The tasks with anything held. */
export function tasksWithHeld(): number[] {
  return [...current().keys()];
}

/** Hold a message at the end of the task's outbox. Whitespace alone is not a message. */
export function holdMessage(
  taskId: number,
  text: string,
  now = Date.now(),
  commentIds: readonly number[] = [],
): HeldMessage | null {
  if (text.trim().length === 0) return null;
  const entry: HeldMessage = {
    id: `${now.toString(36)}-${(seq++).toString(36)}`,
    text,
    heldAt: now,
    ...(commentIds.length > 0 ? { commentIds: [...commentIds] } : {}),
  };
  commit(taskId, [...heldFor(taskId), entry]);
  return entry;
}

/** Change a held message's text, in place. Empty text removes it. */
export function editHeld(taskId: number, id: string, text: string): void {
  if (text.trim().length === 0) {
    removeHeld(taskId, id);
    return;
  }
  const held = heldFor(taskId);
  if (!held.some((h) => h.id === id)) return;
  commit(
    taskId,
    held.map((h) => (h.id === id ? { ...h, text } : h)),
  );
}

export function removeHeld(taskId: number, id: string): void {
  const held = heldFor(taskId);
  if (!held.some((h) => h.id === id)) return;
  editing.delete(id);
  commit(
    taskId,
    held.filter((h) => h.id !== id),
  );
}

/**
 * Open or close a held message for editing. While open, no release passes
 * it; closing it counts as a change, so a release it stopped can go on.
 */
export function setEditing(taskId: number, id: string, on: boolean): void {
  if (on) {
    editing.add(id);
    return;
  }
  if (!editing.delete(id)) return;
  for (const cb of [...listeners]) cb(taskId);
}

/**
 * Send the task's held messages, oldest first, with `send` (which says
 * whether it was delivered), and stop at the first that is not.
 *
 * Each is marked `sending` -- in storage too -- before it is sent, and leaves
 * only once `send` says it was delivered; a failure clears the mark and it
 * stays at the head. So a crash mid-send loses nothing and resends nothing
 * on its own: the next run shows it as `maybeSent` (see `afterCrash`).
 *
 * Stops, keeping order, at an entry open for editing or `maybeSent`, and
 * whenever `mayGo` (asked before each message) says no -- that is waiting,
 * not a failure. A release already under way for the task makes this one do
 * nothing.
 *
 * Resolves with how many went.
 */
export async function releaseHeld(
  taskId: number,
  send: (text: string) => Promise<boolean>,
  mayGo: () => boolean = () => true,
): Promise<number> {
  if (releasing.has(taskId)) return 0;
  releasing.add(taskId);
  let sent = 0;
  try {
    for (;;) {
      const head = heldFor(taskId)[0];
      if (!head || head.maybeSent || editing.has(head.id) || !mayGo()) return sent;
      if (!(await deliver(taskId, head, send))) {
        failing.add(taskId);
        return sent;
      }
      failing.delete(taskId);
      sent++;
    }
  } finally {
    releasing.delete(taskId);
  }
}

/**
 * Send one held message now, whatever holds the rest: the person's choice
 * ("Send Now" in the band). The same discipline as a release -- marked
 * `sending`, removed only once delivered -- and the same lock, so it never
 * overlaps one. Does nothing while a release is under way, or for an entry
 * open for editing or `maybeSent`. Resolves with whether it went.
 */
export async function sendHeldNow(taskId: number, id: string, send: (text: string) => Promise<boolean>): Promise<boolean> {
  const entry = heldFor(taskId).find((h) => h.id === id);
  if (!entry || entry.maybeSent || editing.has(id) || releasing.has(taskId)) return false;
  releasing.add(taskId);
  try {
    return await deliver(taskId, entry, send);
  } finally {
    releasing.delete(taskId);
  }
}

/** Mark `entry` sending, send it, and take it out once delivered; a failure clears the mark. */
async function deliver(taskId: number, entry: HeldMessage, send: (text: string) => Promise<boolean>): Promise<boolean> {
  patch(taskId, entry.id, { sending: true });
  let ok = false;
  try {
    ok = await send(entry.text);
  } catch {
    ok = false;
  }
  if (!ok) {
    patch(taskId, entry.id, { sending: undefined });
    return false;
  }
  const held = heldFor(taskId);
  if (held.some((h) => h.id === entry.id)) commit(taskId, held.filter((h) => h.id !== entry.id));
  for (const cb of [...releaseListeners]) cb(taskId, entry);
  return true;
}

/** Change fields of one entry, if it is still there. Undefined removes a field. */
function patch(taskId: number, id: string, fields: Partial<Pick<HeldMessage, 'sending' | 'maybeSent'>>): void {
  const held = heldFor(taskId);
  if (!held.some((h) => h.id === id)) return;
  commit(
    taskId,
    held.map((h) => {
      if (h.id !== id) return h;
      const next: HeldMessage = { ...h, ...fields };
      for (const k of Object.keys(fields) as Array<keyof typeof fields>) if (fields[k] === undefined) delete next[k];
      return next;
    }),
  );
}

/**
 * The person's choice for a `maybeSent` entry: send it after all. It becomes
 * an ordinary held message, which the next release sends in its turn.
 */
export function sendAnyway(taskId: number, id: string): void {
  patch(taskId, id, { maybeSent: undefined });
}

/** The task's last release ended on a failed write, and nothing has gone since. */
export function lastReleaseFailed(taskId: number): boolean {
  return failing.has(taskId) && heldFor(taskId).length > 0;
}

/**
 * A release, or a Send Now, is sending this task's messages. A new message
 * must queue behind them, not go straight to the pty: two sends at once
 * interleave their writes.
 */
export function isReleasing(taskId: number): boolean {
  return releasing.has(taskId);
}

/** Keep only these tasks' outboxes: the live ones, from a fresh read of the database. */
export function keepOutboxFor(taskIds: Iterable<number>): void {
  const live = new Set(taskIds);
  for (const id of [...current().keys()]) if (!live.has(id)) commit(id, NONE);
}

/** Called with the task whose held messages changed. */
export function onOutboxChange(cb: (taskId: number) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Called with each held message as it is delivered. */
export function onHeldReleased(cb: (taskId: number, held: HeldMessage) => void): () => void {
  releaseListeners.add(cb);
  return () => {
    releaseListeners.delete(cb);
  };
}

/** The task's held messages, re-rendering when they change. */
export function useHeld(taskId: number | null): readonly HeldMessage[] {
  return useSyncExternalStore(
    onOutboxChange,
    () => (taskId === null ? NONE : heldFor(taskId)),
    () => (taskId === null ? NONE : heldFor(taskId)),
  );
}

/** Test seam: forget everything in memory, so the next read comes from storage. */
export function __resetOutbox(): void {
  outbox = null;
  editing.clear();
  releasing.clear();
  failing.clear();
  listeners.clear();
  releaseListeners.clear();
}
