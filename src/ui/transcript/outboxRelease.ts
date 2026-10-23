/**
 * When held messages go (outbox.ts): for every task, not only the one on
 * screen, so a task left while offline still sends once the connection is back.
 *
 * A task's held messages are released, oldest first, through `submitLocked`
 * (send.ts) -- the normal send, one write at a time -- once `canRelease`
 * holds and its session is live. The gate is asked again before each
 * message, so a prompt that opens halfway through stops the rest rather than
 * being typed into. A task whose session is not live is asked to start it
 * (`startPty`, as a send would), and its presence event brings the release
 * back. A failed write is tried again after `RETRY_MS`.
 *
 * Checked on every event that can open the gate: the connection coming back,
 * a session going live, a prompt being answered, the outbox changing. While
 * anything is held the connection is watched (connectivity.ts), which is what
 * notices it coming back.
 *
 * A delivered message's review comments are marked sent here, from the ids
 * kept with it: the composer that held it may be long gone.
 */

import { onPromptChange, pendingPrompt } from '../../capture/hookEvents';
import { isTrustWaiting, onTrustWaiting } from '../../capture/workspaceTrust';
import { markCommentsSent } from '../../db/comments';
import { isOffline, onConnectivityChange, watchConnectivity } from '../../lib/connectivity';
import type { TaskStatus } from '../../types';
import { hasLivePty, onPtyPresenceChange, startPty } from '../Terminal';
import { heldFor, lastReleaseFailed, onHeldReleased, onOutboxChange, releaseHeld, tasksWithHeld } from './outbox';
import { submitLocked } from './send';

/** How long after a failed write the release tries again. */
export const RETRY_MS = 10_000;

export interface ReleaseConditions {
  /** The API is unreachable (connectivity.ts). */
  offline: boolean;
  /**
   * Typed text would land in a dialog: a question or permission prompt
   * (hooks), the workspace trust dialog, or a status of `blocked` (which also
   * covers a session without hooks). The composer's hold uses the same gate.
   */
  promptOpen: boolean;
  /** The session's pty is running. */
  live: boolean;
  /** The first held message may already have been sent, and waits for the person. */
  headMaybeSent: boolean;
  /** The last attempt to write a held message failed. */
  failed: boolean;
}

/** Whether held messages may go now. */
export function canRelease(c: Pick<ReleaseConditions, 'offline' | 'promptOpen'>): boolean {
  return !c.offline && !c.promptOpen;
}

/** What the Queued band says held messages are waiting for: what actually stops them. */
export function heldLabel(c: ReleaseConditions): string {
  if (c.headMaybeSent) return 'Waiting for you to resend or remove the first message';
  if (c.offline) return 'Waiting for connection';
  if (c.promptOpen) return 'Waiting for your answer';
  if (!c.live) return 'Waiting for the session to start';
  if (c.failed) return 'Couldn’t send — retrying';
  return 'Sending';
}

/** The status of the task on screen, the only one Albedo derives a status for here. */
let shown: { taskId: number; status: TaskStatus | null } | null = null;

/** Tell the gate the status of the task on screen; null when none is. */
export function noteShownStatus(taskId: number | null, status: TaskStatus | null): void {
  const was = shown;
  shown = taskId === null ? null : { taskId, status };
  // Leaving `blocked` opens the gate: nothing else announces it.
  if (was?.status === 'blocked' && (shown?.taskId !== was.taskId || shown.status !== 'blocked')) tryRelease(was.taskId);
}

/** Whether typed text would land in a dialog. `status` defaults to what `noteShownStatus` said. */
export function promptOpen(taskId: number, status?: TaskStatus | null): boolean {
  const s = status !== undefined ? status : shown?.taskId === taskId ? shown.status : null;
  return pendingPrompt(taskId) !== null || isTrustWaiting(taskId) || s === 'blocked';
}

export function conditionsFor(taskId: number, status?: TaskStatus | null): ReleaseConditions {
  return {
    offline: isOffline(),
    promptOpen: promptOpen(taskId, status),
    live: hasLivePty(taskId),
    headMaybeSent: heldFor(taskId)[0]?.maybeSent === true,
    failed: lastReleaseFailed(taskId),
  };
}

const retries = new Map<number, ReturnType<typeof setTimeout>>();

function tryRelease(taskId: number): void {
  if (heldFor(taskId).length === 0 || !canRelease(conditionsFor(taskId))) return;
  if (!hasLivePty(taskId)) {
    startPty(taskId);
    return;
  }
  const mayGo = () => canRelease(conditionsFor(taskId)) && hasLivePty(taskId);
  void releaseHeld(taskId, (text) => submitLocked(taskId, text), mayGo).then(() => {
    if (!lastReleaseFailed(taskId) || retries.has(taskId)) return;
    retries.set(
      taskId,
      setTimeout(() => {
        retries.delete(taskId);
        tryRelease(taskId);
      }, RETRY_MS),
    );
  });
}

let users = 0;
let stop: (() => void) | null = null;

function start(): () => void {
  let unwatch: (() => void) | null = null;
  const watch = () => {
    const any = tasksWithHeld().length > 0;
    if (any && unwatch === null) unwatch = watchConnectivity();
    else if (!any && unwatch !== null) {
      unwatch();
      unwatch = null;
    }
  };
  const all = () => {
    for (const id of tasksWithHeld()) tryRelease(id);
  };
  const offs = [
    onConnectivityChange(all),
    onOutboxChange((id) => {
      watch();
      tryRelease(id);
    }),
    onPtyPresenceChange((id, live) => {
      if (live) tryRelease(id);
    }),
    onPromptChange((id, prompt) => {
      if (prompt === null) tryRelease(id);
    }),
    onTrustWaiting((id, waiting) => {
      if (!waiting) tryRelease(id);
    }),
    onHeldReleased((id, held) => {
      if (!held.commentIds || held.commentIds.length === 0) return;
      markCommentsSent(id, held.commentIds).catch((err: unknown) =>
        console.warn('[outbox] the message went out, but its comments could not be marked as sent', err),
      );
    }),
  ];
  watch();
  all();
  return () => {
    for (const off of offs) off();
    for (const t of retries.values()) clearTimeout(t);
    retries.clear();
    unwatch?.();
  };
}

/**
 * Run the release while anything that can send is mounted. Counted, so a
 * second caller shares the first one's listeners.
 */
export function startOutboxRelease(): () => void {
  users++;
  if (stop === null) stop = start();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    users--;
    if (users === 0 && stop !== null) {
      stop();
      stop = null;
    }
  };
}
