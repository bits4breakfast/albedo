/**
 * `/compact` and `/clear` for a task's session, offered where the context
 * reading is.
 *
 * They used to sit in the sidebar's context panel, always on screen. The panel
 * is gone: the task row's hairline shows how full a session is, and the two
 * are offered in the message box only once it matters -- past
 * {@link CLEAR_OFFER_AT} of the window (see {@link ContextClear}). Compact Now
 * is also in the task's ⋯ menu, at any fill ({@link useCommandBlocker}).
 */

import { useEffect, useRef, useState } from 'react';
import type { ContextUsage } from '../capture';
import type { Task, TaskStatus } from '../types';
import { atRest } from '../capture/status';
import { hasLivePty, onPtyPresenceChange } from './Terminal';
import { sendToSession, useSendsWait } from './transcript/send';
import { CONTEXT_WARN, contextLevel, contextReadout, contextTitle } from './StatusDot';
import './gauges/gauges.css';
import './clearcontext.css';

/**
 * Past this share of the window, Compact and Clear are offered beside the
 * message box: the meter's own warn level, so the row and the box agree.
 * Early enough to choose before Claude Code compacts on its own near the top,
 * and while the model still attends well to what it holds.
 */
export const CLEAR_OFFER_AT = CONTEXT_WARN;

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

export const COMPACT: SessionCommand = {
  command: '/compact',
  label: 'Compact Now',
  hint: 'Send /compact: replace the conversation so far with a summary and keep going.',
};

/**
 * Why a command cannot go to the session now, or null when it can. Only on an
 * idle, live session with nothing waiting to send: while a turn runs, typed
 * input is queued behind it and the command would land at a moment nobody
 * chose; on a permission prompt it would be typed into the prompt.
 */
export function commandBlocker(live: boolean, status: TaskStatus, waiting: boolean): string | null {
  if (!live) return 'No session is running for this task.';
  if (!atRest(status)) return 'Available once the session is idle.';
  if (waiting) return 'Not available while messages are waiting to send';
  return null;
}

/** {@link commandBlocker} for a task, kept current; null task, null answer. */
export function useCommandBlocker(task: Pick<Task, 'id' | 'status'> | null): string | null {
  const id = task?.id ?? null;
  const [live, setLive] = useState(() => (id === null ? false : hasLivePty(id)));
  useEffect(() => {
    if (id === null) return;
    setLive(hasLivePty(id));
    return onPtyPresenceChange((taskId, isLive) => {
      if (taskId === id) setLive(isLive);
    });
  }, [id]);
  // While a send would be held (offline, messages waiting, a turn running),
  // a command is not offered.
  const waiting = useSendsWait(id);
  return task === null ? null : commandBlocker(live, task.status, waiting);
}

/**
 * A command button beside the reading it resets.
 *
 * It types the command into the pty exactly as the composer would, so nothing
 * new is learned or parsed: the result shows up in the transcript the same way
 * a typed command does. Clear takes two clicks, because it empties the model's
 * context -- the conversation stays on disk, but the session in progress does
 * not get it back. Compact keeps a summary, so one click is enough.
 *
 * Only when {@link commandBlocker} has nothing against it.
 */
function SessionCommandButton({ task, cmd }: { task: Task; cmd: SessionCommand }) {
  const [arming, setArming] = useState(false);
  const [failed, setFailed] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    setArming(false);
    setFailed(false);
  }, [task.id]);

  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [arming]);

  const blocker = useCommandBlocker(task);
  const ready = blocker === null;
  useEffect(() => {
    if (!ready) setArming(false);
  }, [ready]);

  const why = blocker ?? (arming ? (cmd.confirmHint ?? cmd.hint) : cmd.hint);

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
 * What the message box says about the context: nothing while the session has
 * room; "Context 72%" from the meter's warn level; "Context 93% · compacts
 * soon" from its high level, where Claude Code is about to compact on its own.
 */
export function contextWarning(usage: ContextUsage | null | undefined): { level: 'warn' | 'high'; text: string } | null {
  if (!usage || !Number.isFinite(usage.fraction)) return null;
  const level = contextLevel(usage.fraction);
  if (level === 'quiet') return null;
  const reading = `Context ${contextReadout(usage)}`;
  return { level, text: level === 'high' ? `${reading} · compacts soon` : reading };
}

const AUTO_COMPACT_NOTE =
  'Claude Code compacts the session on its own when the window is nearly full. Compact Now chooses the moment.';

/**
 * "Context 72% · Compact Now · Clear" for the message box's controls row, or
 * nothing while the session has room. The level is the same reading the task
 * row's hairline draws, so the two cannot disagree.
 */
export function ContextClear({ task, usage }: { task: Task; usage: ContextUsage | null | undefined }) {
  const warning = contextWarning(usage);
  if (!usage || !warning) return null;
  return (
    <span className="ctx-clear" title={`${contextTitle(usage)}\n${AUTO_COMPACT_NOTE}`}>
      <span className="ctx-clear-reading" data-level={warning.level}>
        {warning.text}
      </span>
      <SessionCommandButton task={task} cmd={COMPACT} />
      <SessionCommandButton task={task} cmd={CLEAR} />
    </span>
  );
}
