/**
 * `/clear` for a task's session, offered where the context reading is.
 *
 * It used to sit in the sidebar's context panel, always on screen. The panel
 * is gone: the task row's hairline shows how full a session is, and Clear is
 * offered in the message box only once it matters -- past
 * {@link CLEAR_OFFER_AT} of the window (see {@link ContextClear}).
 */

import { useEffect, useRef, useState } from 'react';
import type { ContextUsage } from '../capture';
import type { Task } from '../types';
import { hasLivePty, onPtyPresenceChange, submitPty } from './Terminal';
import { contextReadout, contextTitle } from './StatusDot';

/** Past this share of the window, Clear is offered beside the message box. */
export const CLEAR_OFFER_AT = 0.85;

/** How long the button waits for the second click before standing down. */
const CONFIRM_MS = 4_000;

/**
 * `/clear`, beside the reading it resets.
 *
 * It types the command into the pty exactly as the composer would, so nothing
 * new is learned or parsed: the cleared session shows up in the transcript the
 * same way a typed `/clear` does. Two clicks, because it empties the model's
 * context -- the conversation stays on disk, but the session in progress does
 * not get it back.
 *
 * Only on an idle, live session. While it runs, typed input is queued behind
 * the turn and `/clear` would land at a moment nobody chose; on a permission
 * prompt it would be typed into the prompt.
 */
export function ClearContextButton({ task }: { task: Task }) {
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

  const ready = live && task.status === 'idle';
  useEffect(() => {
    if (!ready) setArming(false);
  }, [ready]);

  const why = !live
    ? 'No session is running for this task.'
    : task.status !== 'idle'
      ? 'Available once the session is idle.'
      : arming
        ? 'Click again to send /clear. The conversation stays on disk; the session starts with an empty context.'
        : 'Send /clear: start this session over with an empty context.';

  const onClick = async () => {
    if (!ready || busyRef.current) return;
    if (!arming) {
      setFailed(false);
      setArming(true);
      return;
    }
    setArming(false);
    busyRef.current = true;
    try {
      setFailed(!(await submitPty(task.id, '/clear')));
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
        {arming ? 'Clear Context?' : 'Clear'}
      </button>
    </span>
  );
}

/**
 * "Context 87% · Clear" for the message box's controls row, or nothing while
 * the session has room. The level is the same reading the task row's
 * hairline draws, so the two cannot disagree.
 */
export function ContextClear({ task, usage }: { task: Task; usage: ContextUsage | null | undefined }) {
  if (!usage || !Number.isFinite(usage.fraction) || usage.fraction < CLEAR_OFFER_AT) return null;
  return (
    <span className="ctx-clear" title={contextTitle(usage)}>
      <span className="ctx-clear-reading">Context {contextReadout(usage)}</span>
      <ClearContextButton task={task} />
    </span>
  );
}
