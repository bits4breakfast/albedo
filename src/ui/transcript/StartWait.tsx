/**
 * What a message sent before Claude Code has started looks like (#439).
 *
 * Nothing is typed into a new pty until its `claude` reports its start
 * (startGate.ts), so a message sent in those seconds is held in the outbox.
 * It must never look as if nothing happened:
 *
 *  - `StartWaitRows`: each such message, in the transcript at once, as yours,
 *    drawn like the message box's own "sending" echo, with "waiting for
 *    Claude Code to start" and a clock. The Held band shows it too, with
 *    Edit and Remove, saying "until Claude Code has started".
 *  - `StartWaitNotice`: past `START_WARN_MS` without a start, a warning above
 *    the band says why that may be (something in the terminal asking a
 *    question) and offers Show Terminal. Albedo never reads the terminal, so
 *    it cannot say what is there, only where to look. Not while the trust
 *    dialog is known to be up: its own card says that, and more.
 *
 * Once Claude Code is up the outbox's release sends them, in order, and each
 * becomes the usual "sending" echo, then the transcript's own row.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { isTrustWaiting, onTrustWaiting } from '../../capture/workspaceTrust';
import { formatDuration } from '../../lib/duration';
import { useHeld, type HeldMessage } from './outbox';
import { foldPastes } from './pastedText';
import { useAwaitingStartSince } from './startGate';

/** How long Claude Code may take to start before the warning says something may be in its way. */
export const START_WARN_MS = 15_000;

/** The row's words after the message. */
export const START_WAIT_TEXT = 'waiting for Claude Code to start';

/** The warning: what is known, then what it may mean, then what happens to the message. */
export const START_WARN_TITLE = 'Claude Code hasn’t started yet.';
export const START_WARN_TEXT =
  'Something in the terminal may be asking a question (a shell prompt, a login). Your message is kept and goes as soon as it starts.';

/**
 * The held messages that wait for the start alone: not one that may already
 * have been sent or was not delivered (it says so in the band and goes only
 * at the person's word), and not one taken into the message box (#399).
 */
export function waitingForStart(held: readonly HeldMessage[]): HeldMessage[] {
  return held.filter((h) => h.maybeSent !== true && h.inBox !== true);
}

/** When a held message began waiting for this process: held before it spawned, from the spawn. */
export function waitStartedAt(h: Pick<HeldMessage, 'heldAt'>, since: number): number {
  return Math.max(h.heldAt, since);
}

/** Now, every second while `on`. */
function useClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

/** The waiting messages and when the pty spawned; none while Claude Code is up. */
function useStartWait(taskId: number | null): { since: number | null; waiting: HeldMessage[] } {
  const since = useAwaitingStartSince(taskId);
  const held = useHeld(taskId);
  return { since, waiting: since === null ? [] : waitingForStart(held) };
}

export function StartWaitRows({ taskId }: { taskId: number | null }): ReactNode {
  const { since, waiting } = useStartWait(taskId);
  const now = useClock(waiting.length > 0);
  if (since === null || waiting.length === 0) return null;
  return waiting.map((h) => (
    <div key={h.id} className="tx-row tx-row-user tx-row-echo tx-row-start-wait" aria-live="polite">
      <div className="tx-gutter">You</div>
      <div className="tx-content tx-start-wait">
        {/* A paste reads as its mention, as in the box and the Held band. */}
        <div className="tx-echo-text">{foldPastes(h.text)}</div>
        <span className="tx-echo-meta tx-start-wait-meta">
          <span className="tx-spinner" aria-hidden="true" />
          {START_WAIT_TEXT} · <span className="tx-start-wait-time">{formatDuration(now - waitStartedAt(h, since))}</span>
        </span>
      </div>
    </div>
  ));
}

export function StartWaitNotice({
  taskId,
  onShowTerminal,
}: {
  taskId: number;
  /** Shows the terminal (Split from Transcript only) and focuses it: App's "answer in terminal". */
  onShowTerminal: ((taskId: number) => void) | undefined;
}): ReactNode {
  const { since, waiting } = useStartWait(taskId);
  const now = useClock(waiting.length > 0);
  // The trust dialog is the question, and its own card already says so.
  const trust = useSyncExternalStore(
    (cb) => onTrustWaiting(cb),
    () => isTrustWaiting(taskId),
    () => false,
  );
  if (since === null || waiting.length === 0 || trust || now - since < START_WARN_MS) return null;
  return (
    <div className="tx-start-warn" role="status">
      <span className="tx-start-warn-text">
        <b>{START_WARN_TITLE}</b> {START_WARN_TEXT}
      </span>
      {onShowTerminal ? (
        <button type="button" className="btn" onClick={() => onShowTerminal(taskId)}>
          Show Terminal
        </button>
      ) : null}
    </div>
  );
}
