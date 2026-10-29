/**
 * Confirm Remote Control before ⇧⌘R turns it on (#128).
 *
 * The shortcut is two modifiers on a letter, easy to hit by accident, and what
 * it does reaches outside the app: the session becomes reachable from the
 * phone and claude.ai. So it asks. Confirming runs the task's ⋯ item
 * (`remoteControlItem`) unchanged: `/remote-control` through `sendPrompt`,
 * held in the outbox during a running turn, left in the message box on a
 * waiting prompt. Cancel, Escape or a click outside does nothing.
 *
 * The same modal shell as the other confirmations (`wt-modal`, worktree.css);
 * no surface or colour of its own.
 */

import { useEffect, useState } from 'react';
import type { Task } from '../types';
import { REMOTE_CONTROL_COMMAND } from './RemoteMark';
import { wrapForTooltip } from './text';
import './worktree.css';

export interface RemoteControlDialogProps {
  task: Pick<Task, 'title' | 'status'>;
  /** Turn it on: the ⋯ item's `onSelect`. The dialog closes after. */
  onConfirm: () => void;
  onClose: () => void;
}

export const REMOTE_CONFIRM_TITLE = 'Make This Session Available Remotely?';

export default function RemoteControlDialog({ task, onConfirm, onClose }: RemoteControlDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    // Capture, as the ⋯ menu does: the editor closes its file on Escape from
    // a window listener of its own, which must not also hear this one.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Give the keyboard back to where ⇧⌘R was pressed -- the terminal, the
  // message box, the editor -- once the dialog goes, whichever way.
  // Read while rendering: by the time an effect runs, autoFocus has already
  // moved focus to the confirm button.
  const [from] = useState(() => document.activeElement);
  useEffect(() => {
    return () => {
      if (from instanceof HTMLElement && from.isConnected) from.focus();
    };
  }, [from]);

  const confirm = () => {
    onConfirm();
    onClose();
  };

  // Where the command goes, in sendPrompt's words: a waiting prompt is never
  // typed into, and a running turn is never interrupted.
  const when =
    task.status === 'blocked'
      ? 'Claude is waiting on you, so the command goes to the message box to send when you are ready.'
      : task.status === 'running'
        ? 'A turn is running, so the command waits and is sent when it ends.'
        : 'The command is sent to the session now.';

  return (
    <div
      className="wt-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="wt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rc-title"
        aria-describedby="rc-body"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="rc-title">
            {REMOTE_CONFIRM_TITLE}
          </h2>
          <span className="wt-modal-sub wt-modal-task" title={wrapForTooltip(task.title)}>
            {task.title}
          </span>
        </div>

        <div className="wt-modal-body" id="rc-body">
          Sends <span className="wt-mono">{REMOTE_CONTROL_COMMAND}</span> to the session. You can then continue it
          from your phone or on claude.ai.
          <div className="wt-hint">{when}</div>
        </div>

        <div className="wt-modal-foot">
          <span className="wt-foot-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={confirm} autoFocus>
            Make Available Remotely
          </button>
        </div>
      </div>
    </div>
  );
}
