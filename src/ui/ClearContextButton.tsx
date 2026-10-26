/**
 * `/compact` and `/clear` for a task's session, offered where the context
 * reading is.
 *
 * They used to sit in the sidebar's context panel, always on screen. The panel
 * is gone: the task row's hairline shows how full a session is, and the two
 * are offered in the message box only once it matters -- past
 * {@link CLEAR_OFFER_AT} of the window (see {@link ContextClear}).
 */

import { useEffect, useRef, useState } from 'react';
import type { ContextUsage } from '../capture';
import type { Task } from '../types';
import { atRest } from '../capture/status';
import { hasLivePty, onPtyPresenceChange } from './Terminal';
import { sendToSession, useSendsWait } from './transcript/send';
import { contextReadout, contextTitle } from './StatusDot';
import './gauges/gauges.css';
import './clearcontext.css';

/**
 * Past this share of the window, Compact and Clear are offered beside the
 * message box. Early enough to choose before Claude Code compacts on its own
 * near the top, and while the model still attends well to what it holds.
 */
export const CLEAR_OFFER_AT = 0.7;

/** How long the button waits for the second click before standing down. */
const CONFIRM_MS = 4_000;

interface SessionCommand {
  /** What is typed into the pty. */
  command: '/clear' | '/compact';
  label: string;
  /** Second-click label; absent means one click sends it. */
  confirmLabel?: string;
  hint: string;
  confirmHint?: string;
}

const CLEAR: SessionCommand = {
  command: '/clear',
  label: 'Clear',
  confirmLabel: 'Clear Context?',
  hint: 'Send /clear: start this session over with an empty context.',
  confirmHint:
    'Click again to send /clear. The conversation stays on disk; the session starts with an empty context.',
};

const COMPACT: SessionCommand = {
  command: '/compact',
  label: 'Compact',
  hint: 'Send /compact: replace the conversation so far with a summary and keep going.',
};

/**
 * A command button beside the reading it resets.
 *
 * It types the command into the pty exactly as the composer would, so nothing
 * new is learned or parsed: the result shows up in the transcript the same way
 * a typed command does. Clear takes two clicks, because it empties the model's
 * context -- the conversation stays on disk, but the session in progress does
 * not get it back. Compact keeps a summary, so one click is enough.
 *
 * Only on an idle, live session. While it runs, typed input is queued behind
 * the turn and the command would land at a moment nobody chose; on a
 * permission prompt it would be typed into the prompt.
 */
function SessionCommandButton({ task, cmd }: { task: Task; cmd: SessionCommand }) {
  const [live, setLive] = useState(() => hasLivePty(task.id));
  const [arming, setArming] = useState(false);
  const [failed, setFailed] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    setLive(hasLivePty(task.id));
    setArming(false);
    setFailed(false);
    return onPtyPresenceChange((id, isLive) => {
      if (id === task.id) setLive(isLive);
    });
  }, [task.id]);

  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [arming]);

  // While a send would be held (offline, messages waiting, a turn running),
  // it is not offered.
  const waiting = useSendsWait(task.id);
  const ready = live && atRest(task.status) && !waiting;
  useEffect(() => {
    if (!ready) setArming(false);
  }, [ready]);

  const why = !live
    ? 'No session is running for this task.'
    : !atRest(task.status)
      ? 'Available once the session is idle.'
      : waiting
        ? 'Not available while messages are waiting to send'
        : arming
        ? (cmd.confirmHint ?? cmd.hint)
        : cmd.hint;

  const onClick = async () => {
    if (!ready || busyRef.current) return;
    if (cmd.confirmLabel && !arming) {
      setFailed(false);
      setArming(true);
      return;
    }
    setArming(false);
    busyRef.current = true;
    try {
      // Held, not lost, if sends started waiting since the click was offered:
      // it goes once the session is idle (send.ts).
      setFailed((await sendToSession(task.id, cmd.command)) === 'failed');
    } catch {
      setFailed(true);
    } finally {
      busyRef.current = false;
    }
  };

  return (
    <span className="gz-actions">
      {failed && <span className="gz-action-note">Could not send</span>}
      <button
        type="button"
        className={arming ? 'btn gz-clear gz-clear-armed' : 'btn btn-ghost gz-clear'}
        disabled={!ready}
        title={why}
        onClick={() => void onClick()}
      >
        {arming ? cmd.confirmLabel : cmd.label}
      </button>
    </span>
  );
}

/**
 * "Context 72% · Compact · Clear" for the message box's controls row, or nothing while
 * the session has room. The level is the same reading the task row's
 * hairline draws, so the two cannot disagree.
 */
export function ContextClear({ task, usage }: { task: Task; usage: ContextUsage | null | undefined }) {
  if (!usage || !Number.isFinite(usage.fraction) || usage.fraction < CLEAR_OFFER_AT) return null;
  return (
    <span className="ctx-clear" title={contextTitle(usage)}>
      <span className="ctx-clear-reading">Context {contextReadout(usage)}</span>
      <SessionCommandButton task={task} cmd={COMPACT} />
      <SessionCommandButton task={task} cmd={CLEAR} />
    </span>
  );
}
