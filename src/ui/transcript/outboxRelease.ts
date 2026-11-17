/**
 * When held messages go (outbox.ts): for every task, not only the one on
 * screen, so a task left while offline still sends once the connection is back.
 *
 * A task's held messages are released, oldest first, through `submitLocked`
 * (send.ts) -- the normal send, one write at a time -- once `canRelease`
 * holds and its session is live. Plain messages go together as one write
 * (#240, `nextRun` in outbox.ts); a slash command goes alone, after the turn
 * the messages before it start. The gate is asked again before each write,
 * so a prompt that opens halfway through stops the rest rather than being
 * typed into. A task whose session is not live is asked to start it
 * (`startPty`, as a send would), and its presence event brings the release
 * back. A failed write is tried again after `RETRY_MS`.
 *
 * A live session whose `claude` has not reported its start yet (startGate.ts,
 * #439) is not typed into: the release waits for that, and the held messages
 * go, in order, once it is up.
 *
 * Checked on every event that can open the gate: the connection coming back,
 * a session going live or reporting its start, a prompt being answered, a
 * turn ending, the outbox changing. While anything is held the connection is watched
 * (connectivity.ts), which is what notices it coming back.
 *
 * A delivered message's review comments are marked sent here, from the ids
 * kept with it: the composer that held it may be long gone.
 */

import { onPromptChange, pendingPrompt } from '../../capture/hookEvents';
import { isTrustWaiting, onTrustWaiting } from '../../capture/workspaceTrust';
import { onPreviewChange, pendingPreview } from '../../capture/previewGate';
import { onDeletionChange, pendingDeletion } from '../../capture/githubGate';
import { markCarriedSent } from './codeComments';
import { isOffline, onConnectivityChange, watchConnectivity } from '../../lib/connectivity';
import type { TaskStatus } from '../../types';
import { hasLivePty, onPtyPresenceChange, startPty } from '../Terminal';
import {
  allNowSize,
  heldFor,
  lastReleaseFailed,
  onHeldReleased,
  onOutboxChange,
  releaseHeld,
  sendAllHeldNow,
  sendHeldNow,
  tasksWithHeld,
} from './outbox';
import { isSlashCommand, submitLocked } from './send';
import { isTurnRunning, onTurnChange } from './turn';
import { awaitingDelivery, onAwaitingDeliveryChange } from './deliveryGate';
import { awaitingStart, onAwaitingStartChange } from './startGate';

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
  /**
   * A turn is running in the session (turn.ts): typed now, a message would
   * go with any dialog the turn opens next.
   */
  turnRunning: boolean;
  /** The session's pty is running. */
  live: boolean;
  /** The first held message may already have been sent, and waits for the person. */
  headMaybeSent: boolean;
  /** The last attempt to write a held message failed. */
  failed: boolean;
  /**
   * The last message written is not in the transcript yet (deliveryGate.ts,
   * #433): if Claude Code did not take it, the next would be glued onto it.
   */
  awaitingDelivery?: boolean;
  /**
   * The session's pty is up and `claude` has not reported its start
   * (startGate.ts, #439): typed now, a message could be read by whatever
   * the shell runs first.
   */
  starting?: boolean;
}

/** What the band says holds them while Claude Code is not up: not running, or not started yet (#439). */
export const START_HINT = 'until Claude Code has started';

/** Whether held messages may go now. */
export function canRelease(
  c: Pick<ReleaseConditions, 'offline' | 'promptOpen' | 'turnRunning' | 'awaitingDelivery' | 'starting'>,
): boolean {
  return !c.offline && !c.promptOpen && !c.turnRunning && c.awaitingDelivery !== true && c.starting !== true;
}

/**
 * The head of the band's outbox group (#409): Held, whatever holds them --
 * the hint says why -- and Sending once nothing does.
 */
export function heldLabel(c: ReleaseConditions): 'Held' | 'Sending' {
  if (
    c.headMaybeSent ||
    c.offline ||
    c.promptOpen ||
    c.turnRunning ||
    !c.live ||
    c.failed ||
    c.awaitingDelivery === true ||
    c.starting === true
  ) {
    return 'Held';
  }
  return 'Sending';
}

/**
 * Beside `heldLabel`, why they are held, in plain words (#409): what
 * actually stops them, first. Null while they are being sent. When the head
 * offers Send All Now, it is that button's tooltip instead (#290).
 */
export function heldHint(c: ReleaseConditions): string | null {
  if (c.headMaybeSent) return 'until you resend or remove the first one';
  if (c.offline) return 'until you\u2019re online';
  if (c.promptOpen) return 'until you answer';
  if (c.turnRunning) return 'until this turn ends';
  if (c.awaitingDelivery === true) return 'until the last message reaches Claude Code';
  if (!c.live || c.starting === true) return START_HINT;
  if (c.failed) return 'couldn\u2019t send \u2014 retrying';
  return null;
}

/**
 * The head's tooltip: how they go once nothing holds them. `together` is how
 * many go as one message next (#240). Null when that is nothing to say.
 */
export function heldGoes(c: ReleaseConditions, together = 1): string | null {
  if (c.headMaybeSent) return null;
  if (c.offline) return together > 1 ? 'Sent together, as one message, once you\u2019re online' : 'Sent in order once you\u2019re online';
  if (!c.promptOpen && c.starting === true) {
    return together > 1 ? 'Sent together, as one message, the moment Claude Code is up' : 'Sent the moment Claude Code is up';
  }
  if (!c.promptOpen && c.turnRunning) {
    return together > 1 ? 'Sent together, as one message, when Claude finishes this turn' : 'Sent when Claude finishes this turn';
  }
  return null;
}

/**
 * "Send Now" on a held row: offered while the turn is all that holds it --
 * online, with nothing waiting for the person -- and usable only with no
 * prompt open (typed then, it would answer it) and a live session.
 */
export function sendNowOffered(c: ReleaseConditions): boolean {
  return c.turnRunning && !c.offline && !c.headMaybeSent;
}
export function sendNowAllowed(c: ReleaseConditions): boolean {
  return sendNowOffered(c) && !c.promptOpen && c.live && c.awaitingDelivery !== true && c.starting !== true;
}

/**
 * Send Now for this held text: never for a command, which must only reach
 * an idle session (send.ts) -- typed into a turn it is chat text, or lands
 * in a dialog.
 */
export function sendNowOfferedFor(c: ReleaseConditions, text: string): boolean {
  return sendNowOffered(c) && !isSlashCommand(text);
}

/**
 * Send one held message into the running turn, at the person's word: it joins
 * Claude Code's queue, as a message sent mid-turn did before #61. Checked
 * again here, since the band may be a render behind. False when it did not
 * go: not allowed now, or a release holds the task's lock.
 */
export function sendNow(taskId: number, id: string): Promise<boolean> {
  const held = heldFor(taskId).find((h) => h.id === id);
  if (!held || !sendNowOfferedFor(conditionsFor(taskId), held.text) || !sendNowAllowed(conditionsFor(taskId))) {
    return Promise.resolve(false);
  }
  return sendHeldNow(taskId, id, (text, ids) => submitLocked(taskId, text, undefined, ids));
}

/**
 * "Send All Now" in the band's head (#290): offered on the same terms as a
 * row's Send Now, when `size` (`allNowSize`: every held message not being
 * edited, each one sendable now) is two or more. Usable when Send Now is.
 */
export function sendAllNowOffered(c: ReleaseConditions, size: number): boolean {
  return sendNowOffered(c) && size >= 2;
}

/**
 * Send every held message not being edited into the running turn now, as one
 * message, through the same gateway and lock as `sendNow`. Checked again
 * here, since the band may be a render behind. False when it did not go.
 */
export function sendAllNow(taskId: number): Promise<boolean> {
  const c = conditionsFor(taskId);
  if (!sendAllNowOffered(c, allNowSize(taskId)) || !sendNowAllowed(c)) return Promise.resolve(false);
  return sendAllHeldNow(taskId, (text, ids) => submitLocked(taskId, text, undefined, ids));
}

/** The status of the task on screen, the only one Albedo derives a status for here. */
let shown: { taskId: number; status: TaskStatus | null } | null = null;

/** Tell the gate the status of the task on screen; null when none is. */
export function noteShownStatus(taskId: number | null, status: TaskStatus | null): void {
  const was = shown;
  shown = taskId === null ? null : { taskId, status };
  // Leaving `blocked` opens the gate: nothing else announces it.
  if (was?.status === 'blocked' && (shown?.taskId !== was.taskId || shown.status !== 'blocked')) reopened(was.taskId);
}

/** Whether typed text would land in a dialog. `status` defaults to what `noteShownStatus` said. */
export function promptOpen(taskId: number, status?: TaskStatus | null): boolean {
  const s = status !== undefined ? status : shown?.taskId === taskId ? shown.status : null;
  // A waiting preview (#348) too: the session is inside a tool call that
  // waits, and typed text would only queue behind it.
  // A comment's deletion on GitHub (#427) the same: the session's call waits.
  return (
    pendingPrompt(taskId) !== null ||
    isTrustWaiting(taskId) ||
    pendingPreview(taskId) !== null ||
    pendingDeletion(taskId) !== null ||
    s === 'blocked'
  );
}

export function conditionsFor(taskId: number, status?: TaskStatus | null): ReleaseConditions {
  return {
    offline: isOffline(),
    promptOpen: promptOpen(taskId, status),
    turnRunning: isTurnRunning(taskId),
    live: hasLivePty(taskId),
    headMaybeSent: heldFor(taskId)[0]?.maybeSent === true,
    failed: lastReleaseFailed(taskId),
    awaitingDelivery: awaitingDelivery(taskId),
    starting: awaitingStart(taskId),
  };
}

const retries = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * A gate cleared -- a prompt answered, the trust dialog gone, a preview or a
 * deletion settled, `blocked` left, a turn ended, a message confirmed, the
 * start reported. That is a reason to send into the session that is there,
 * never to start one: the gate also clears when the process ends (the trust
 * dialog declined with "No, exit"), and starting it again would open the same
 * dialog, over and over. Only a new reason to send -- the outbox changing,
 * the connection coming back -- may start a session (#439 review).
 */
function reopened(taskId: number): void {
  if (hasLivePty(taskId)) tryRelease(taskId);
}

function tryRelease(taskId: number): void {
  if (heldFor(taskId).length === 0 || !canRelease(conditionsFor(taskId))) return;
  if (!hasLivePty(taskId)) {
    startPty(taskId);
    return;
  }
  const mayGo = () => canRelease(conditionsFor(taskId)) && hasLivePty(taskId);
  void releaseHeld(taskId, (text, ids) => submitLocked(taskId, text, undefined, ids), mayGo).then(() => {
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
      if (prompt === null) reopened(id);
    }),
    onTrustWaiting((id, waiting) => {
      if (!waiting) reopened(id);
    }),
    onPreviewChange((id) => {
      if (pendingPreview(id) === null) reopened(id);
    }),
    onDeletionChange((id) => {
      if (pendingDeletion(id) === null) reopened(id);
    }),
    onTurnChange(reopened),
    // The last message reached the transcript: the next may go.
    onAwaitingDeliveryChange((id) => {
      if (!awaitingDelivery(id)) reopened(id);
    }),
    // Claude Code reported its start (#439), or Send Anyway. The wait also
    // ends when the pty does: `reopened` starts nothing then.
    onAwaitingStartChange((id) => {
      if (!awaitingStart(id)) reopened(id);
    }),
    onHeldReleased((id, held) => {
      if (!held.commentIds || held.commentIds.length === 0) return;
      // On their way until the sent mark is read back: never To Send between (#404).
      markCarriedSent(id, held.commentIds, '[outbox] the message went out, but its comments could not be marked as sent');
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
