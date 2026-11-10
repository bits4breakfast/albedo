/**
 * The one way Albedo submits text to a session: the composer, the outbox's
 * release, and the buttons that send a prompt (Push, Create PR, Squash, the
 * model picker, Clear / Compact) all come through here.
 *
 * Rules no caller can skip:
 *  - **Hold when the composer would** (`mustHold`): offline, behind messages
 *    already held or being released, or while a turn is running (turn.ts:
 *    typed during one, it would go with any dialog the turn opens). The text
 *    joins the outbox (outbox.ts) at the end, so the order is the order
 *    things were sent. A command is held like a message: the release sends
 *    only into an idle session -- online, no prompt, no turn -- so `/clear`
 *    or `/model x` never lands in a turn as chat text. Order is kept, so
 *    whatever is held behind a `/clear` goes into the fresh context it
 *    makes, after it.
 *  - **One write at a time per task** (`submitLocked`). `submitPty` writes the
 *    paste, pauses, then writes Enter; two calls inside that pause merge into
 *    one message. Every submit for a task waits for the one before it.
 */

import { isOffline, useOffline } from '../../lib/connectivity';
import { submitPty } from '../Terminal';
import { heldFor, holdMessage, isReleasing, useHeld } from './outbox';
import { isTurnRunning, noteSubmitted, useTurnRunning } from './turn';

/** What happened to it: sent to the session, held in the outbox, or neither. */
export type SessionSendOutcome = 'sent' | 'held' | 'failed';

/** Whether a send now would join the outbox rather than go to the pty. */
export function mustHold(taskId: number): boolean {
  return isOffline() || heldFor(taskId).length > 0 || isReleasing(taskId) || isTurnRunning(taskId);
}

export { isSlashCommand } from './slash';

/**
 * For the command buttons (model picker, Clear / Compact): a send now would
 * be held, so they are not offered. A command they send changes what they
 * show at once; one held behind a turn would take effect later than it says.
 */
export function useSendsWait(taskId: number | null): boolean {
  const offline = useOffline();
  const held = useHeld(taskId);
  const turn = useTurnRunning(taskId);
  return offline || held.length > 0 || turn;
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

const submitted = new Set<(taskId: number, text: string) => void>();

/**
 * Hear every text delivered to a session, whichever path sent it: the
 * composer, a button, the outbox's release. Called once the write succeeded,
 * before the caller learns it did. For what follows a particular command
 * (remoteWait.ts: `/remote-control`); nothing here changes how text is sent.
 */
export function onSessionSubmit(cb: (taskId: number, text: string) => void): () => void {
  submitted.add(cb);
  return () => void submitted.delete(cb);
}

/**
 * `submitPty`, after any other submit to the same task has finished. A
 * delivered submit starts a turn as far as turn.ts knows, until the
 * transcript says otherwise.
 */
export function submitLocked(taskId: number, text: string): Promise<boolean> {
  return withPtyLock(taskId, async () => {
    const ok = await submitPty(taskId, text);
    if (ok) {
      noteSubmitted(taskId);
      for (const cb of [...submitted]) {
        try {
          cb(taskId, text);
        } catch (err) {
          console.warn('[send] a submit listener failed', err);
        }
      }
    }
    return ok;
  });
}

/** Send text to the task's session now, or hold it in the outbox (`mustHold`). */
export async function sendToSession(taskId: number, text: string): Promise<SessionSendOutcome> {
  if (mustHold(taskId)) return holdMessage(taskId, text) ? 'held' : 'failed';
  try {
    return (await submitLocked(taskId, text)) ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
