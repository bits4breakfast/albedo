/**
 * The one way Albedo submits text to a session: the composer, the outbox's
 * release, and the buttons that send a prompt (Push, Create PR, Squash, the
 * model picker, Clear / Compact) all come through here.
 *
 * Two rules, which no caller can skip:
 *  - **Hold when the composer would** (`mustHold`): offline, or behind
 *    messages already held or being released. The text joins the outbox
 *    (outbox.ts) at the end, so the order is the order things were sent.
 *  - **A command never waits** (`isSlashCommand`). Released later, after a
 *    held message has started a turn, `/clear` or `/model x` would be pasted
 *    into that turn as chat text. While a send would be held, a command is
 *    refused instead, and stays with whoever sent it.
 *  - **One write at a time per task** (`submitLocked`). `submitPty` writes the
 *    paste, pauses, then writes Enter; two calls inside that pause merge into
 *    one message. Every submit for a task waits for the one before it.
 */

import { isOffline, useOffline } from '../../lib/connectivity';
import { submitPty } from '../Terminal';
import { heldFor, holdMessage, isReleasing, useHeld } from './outbox';

/** What happened to it: sent to the session, held in the outbox, or neither. */
export type SessionSendOutcome = 'sent' | 'held' | 'failed';

/** Whether a send now would join the outbox rather than go to the pty. */
export function mustHold(taskId: number): boolean {
  return isOffline() || heldFor(taskId).length > 0 || isReleasing(taskId);
}

/**
 * A Claude Code command: the trimmed text starts with `/` and its first word
 * is a command name (`/clear`, `/model opus`, `/review:pr`), not a path
 * (`/Users/me/shot.png look`).
 */
export function isSlashCommand(body: string): boolean {
  const first = body.trim().split(/\s+/, 1)[0] ?? '';
  return /^\/[A-Za-z][\w:-]*$/.test(first);
}

/** Why a command was not sent, for the composer to show. */
export const COMMAND_CANNOT_WAIT = 'Commands can\u2019t wait in the queue. Send it when the connection is back.';
/** The same, while a prompt holds the send: after the answer the turn goes on, and it would land in it. */
export const COMMAND_CANNOT_WAIT_PROMPT = 'Commands can\u2019t wait for the prompt. Send it once Claude has finished.';

/** For the command buttons: sends would be held now, so they are not offered. */
export function useSendsWait(taskId: number): boolean {
  const offline = useOffline();
  const held = useHeld(taskId);
  return offline || held.length > 0;
}

const chains = new Map<number, Promise<void>>();

/**
 * Run `fn` once every earlier locked run for the task has finished; at once
 * when none is running, so an uncontended send starts in the same tick.
 */
export function withPtyLock<T>(taskId: number, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(taskId);
  let run: Promise<T>;
  if (prev) run = prev.then(fn);
  else {
    try {
      run = fn();
    } catch (err) {
      run = Promise.reject(err);
    }
  }
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(taskId, tail);
  void tail.then(() => {
    if (chains.get(taskId) === tail) chains.delete(taskId);
  });
  return run;
}

/** `submitPty`, after any other submit to the same task has finished. */
export function submitLocked(taskId: number, text: string): Promise<boolean> {
  return withPtyLock(taskId, () => submitPty(taskId, text));
}

/**
 * Send text to the task's session now, or hold it in the outbox. A command
 * that would be held is refused (`failed`, see `isSlashCommand`).
 */
export async function sendToSession(taskId: number, text: string): Promise<SessionSendOutcome> {
  if (mustHold(taskId)) return !isSlashCommand(text) && holdMessage(taskId, text) ? 'held' : 'failed';
  try {
    return (await submitLocked(taskId, text)) ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
