/**
 * What Albedo knows after it sends `/remote-control` (#343), per task, in
 * memory only.
 *
 * Asked for while Remote Control was already on, Claude Code does not turn it
 * on again: it shows a menu in the terminal ("Disconnect this session / Show
 * QR code / Continue") and waits. Measured on 2.1.322: nothing reaches the
 * transcript or the hook events while it waits, so on its own the transcript
 * pane just looked stuck. Albedo never reads the terminal, so this is judged
 * only from what Albedo sent and what the transcript did or did not show
 * afterwards:
 *
 *  - `asked`: the ⋯ item, ⇧⌘R or its dialog asked for it; it may still be
 *    held in the outbox behind a running turn. Ends when it is written to the
 *    session, left in the message box, fails, or leaves the outbox unsent.
 *  - `sent`: written to the session (any path: send.ts tells every write), at
 *    `at`. Remote Control coming on (capture/remoteSession.ts) ends it.
 *  - `menu`: `MENU_AFTER_MS` after the write, Remote Control had not come on
 *    and the session had not moved on, so Claude Code is taken to be showing
 *    its menu. Ends when the session moves on (a turn starts or ends, Claude
 *    Code takes from its queue), Remote Control comes on, or it is dismissed.
 *
 * Every phase ends with the task's pty. While any phase is up, Make Available
 * Remotely is not offered, so the command is never sent twice.
 */

import { useSyncExternalStore } from 'react';
import { onCaptureUpdate } from '../capture';
import { onQueueChange, turnMarksFor } from '../capture/queue';
import { onRemoteSessionChange, remoteControlSince } from '../capture/remoteSession';
import { onPtyPresenceChange } from './Terminal';
import { heldFor, onOutboxChange } from './transcript/outbox';
import { onSessionSubmit } from './transcript/send';
import { sessionOfTask } from './transcript/turn';

/** What the ⋯ item sends: the command as typed in Claude Code. */
export const REMOTE_CONTROL_COMMAND = '/remote-control';

/** `/remote-control` or its short form, as sent from anywhere (the message box too). */
export function isRemoteControlCommand(text: string): boolean {
  return /^\/(remote-control|rc)(\s|$)/.test(text.trim());
}

/**
 * How long after the write the menu is assumed. Measured, 2.1.291-2.1.316:
 * the "is active" line followed the command's own line by 0.7-1.1 s (7
 * pairs); four seconds leaves room for a slow connection.
 */
export const MENU_AFTER_MS = 4_000;

export type RemoteWait = { phase: 'asked' } | { phase: 'sent'; at: number } | { phase: 'menu'; at: number };

const waits = new Map<number, RemoteWait>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<(taskId: number) => void>();

/** The task's phase, or null when Albedo is waiting on nothing. */
export function remoteWaitFor(taskId: number): RemoteWait | null {
  return waits.get(taskId) ?? null;
}

/** Called with the task whose phase changed. */
export function onRemoteWaitChange(cb: (taskId: number) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** {@link remoteWaitFor}, re-rendering when it changes. */
export function useRemoteWait(taskId: number | null): RemoteWait | null {
  return useSyncExternalStore(
    onRemoteWaitChange,
    () => (taskId === null ? null : remoteWaitFor(taskId)),
    () => null,
  );
}

function set(taskId: number, next: RemoteWait | null): void {
  const t = timers.get(taskId);
  if (t !== undefined) clearTimeout(t);
  timers.delete(taskId);
  if (next === null) {
    if (!waits.has(taskId)) return;
    waits.delete(taskId);
  } else {
    waits.set(taskId, next);
    listen();
  }
  for (const cb of [...listeners]) cb(taskId);
}

/** The ⋯ item, ⇧⌘R or its dialog asked for Remote Control on the task. */
export function noteRemoteAsked(taskId: number): void {
  if (waits.has(taskId)) return;
  set(taskId, { phase: 'asked' });
}

/**
 * Where the asked-for command went (`sendPrompt`'s outcome). Left in the
 * message box, or not sent at all, it is no longer Albedo's to wait on: the
 * write from the box starts a watch of its own.
 */
export function noteRemoteAskOutcome(taskId: number, outcome: 'sent' | 'held' | 'composer' | 'failed'): void {
  if ((outcome === 'composer' || outcome === 'failed') && waits.get(taskId)?.phase === 'asked') set(taskId, null);
}

/** The notice's own way out, for a menu answered with nothing written after. */
export function dismissRemoteWait(taskId: number): void {
  set(taskId, null);
}

function written(taskId: number, text: string): void {
  if (!isRemoteControlCommand(text)) return;
  const at = Date.now();
  set(taskId, { phase: 'sent', at });
  timers.set(
    taskId,
    setTimeout(() => {
      timers.delete(taskId);
      void settle(taskId, at, true);
    }, MENU_AFTER_MS),
  );
}

/** The session wrote a turn's start or end, or Claude Code took from its queue, after `at`. */
function movedOn(sessionId: string, at: number): boolean {
  const m = turnMarksFor(sessionId);
  if (m === null) return false;
  return [m.startedAt, m.endedAt, m.pendingAt].some((t) => t !== null && t > at);
}

/**
 * Look again at the watch that began at `at`. Remote Control on ends any
 * phase. Moving on ends `menu`, and at the deadline (`due`) ends `sent`;
 * at the deadline with neither, it becomes `menu`.
 */
async function settle(taskId: number, at: number, due = false): Promise<void> {
  const w = waits.get(taskId);
  if (!w || w.phase === 'asked' || w.at !== at) return;
  const sessionId = sessionOfTask(taskId);
  let on = false;
  if (sessionId !== null) {
    try {
      on = (await remoteControlSince(sessionId, at)) !== null;
    } catch {
      /* unknown: decided by what else is known */
    }
  }
  const now = waits.get(taskId);
  if (!now || now.phase === 'asked' || now.at !== at) return;
  if (on) return set(taskId, null);
  const moved = sessionId !== null && movedOn(sessionId, at);
  if (now.phase === 'menu') {
    if (moved) set(taskId, null);
    return;
  }
  if (!due) return;
  set(taskId, moved ? null : { phase: 'menu', at });
}

function settleSession(sessionId: string): void {
  for (const [taskId, w] of waits) {
    if (w.phase !== 'asked' && sessionOfTask(taskId) === sessionId) void settle(taskId, w.at);
  }
}

let offs: (() => void)[] | null = null;

/** Hear what can end a phase, from the first watch on. */
function listen(): void {
  if (offs !== null) return;
  offs = [
    onPtyPresenceChange((taskId, live) => {
      if (!live) set(taskId, null);
    }),
    // Asked, then removed from the outbox before it went.
    onOutboxChange((taskId) => {
      if (waits.get(taskId)?.phase !== 'asked') return;
      if (!heldFor(taskId).some((h) => isRemoteControlCommand(h.text))) set(taskId, null);
    }),
    onQueueChange(settleSession),
    onRemoteSessionChange(settleSession),
    onCaptureUpdate((u) => {
      if (u?.sessionId) settleSession(u.sessionId);
    }),
  ];
}

// Every write to a session, whichever path made it, comes through send.ts.
onSessionSubmit(written);

/** Test seam: put a task in a phase without the path that leads there. */
export function __setRemoteWait(taskId: number, wait: RemoteWait | null): void {
  set(taskId, wait);
}

/** Test seam. */
export function __resetRemoteWaits(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  waits.clear();
  for (const off of offs ?? []) off();
  offs = null;
}
