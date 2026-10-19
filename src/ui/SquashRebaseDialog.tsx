/**
 * Confirm a squash & rebase before Claude is asked to do it.
 *
 * Rewriting a branch is the one git action here that is awkward to undo, so
 * the dialog shows what it will act on -- the commits that become one, the
 * base they land on, what is uncommitted -- and takes the two decisions the
 * prompt cannot make for you: what happens to uncommitted work, and whether to
 * push afterwards.
 *
 * Confirming IS the confirmation, so on an idle, live session the prompt is
 * sent straight to the pty. Otherwise (running, on a permission prompt, no
 * session) it goes to the message box, whose send path already knows how to
 * wait for each of those.
 */

import { useEffect, useRef, useState } from 'react';
import type { Task } from '../types';
import type { BranchCommit } from '../git/worktree';
import { hasLivePty, onPtyPresenceChange } from './Terminal';
import { sendPrompt } from './sendPrompt';
import { squashRebasePrompt } from './gitPrompts';
import { relativeTime } from './TaskList';
import './worktree.css';

export interface SquashRebaseDialogProps {
  task: Task;
  /** The branch's commits, newest first, as the files pane last read them. */
  commits: readonly BranchCommit[];
  /** Uncommitted paths, worktree-relative. */
  uncommitted: readonly string[];
  onClose: () => void;
}

export default function SquashRebaseDialog({ task, commits, uncommitted, onClose }: SquashRebaseDialogProps) {
  const [includeUncommitted, setIncludeUncommitted] = useState(false);
  const [push, setPush] = useState(false);
  const [live, setLive] = useState(() => hasLivePty(task.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [now] = useState(() => Date.now());

  useEffect(
    () =>
      onPtyPresenceChange((id, isLive) => {
        if (id === task.id) setLive(isLive);
      }),
    [task.id],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const direct = live && task.status === 'idle';
  const dirty = uncommitted.length > 0;
  const n = commits.length;

  const confirm = async () => {
    if (busyRef.current) return;
    const text = squashRebasePrompt(task, {
      includeUncommitted: dirty && includeUncommitted,
      push,
      commitCount: n,
    });
    busyRef.current = true;
    setBusy(true);
    try {
      const outcome = await sendPrompt(task, text);
      if (outcome !== 'failed') onClose();
      else
        setError(
          direct
            ? 'Could not reach the session. Nothing was sent.'
            : 'Open the task’s transcript to get its message box, then try again.',
        );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      className="wt-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busyRef.current) onClose();
      }}
    >
      <div
        className="wt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sq-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="sq-title">
            Squash &amp; rebase
          </h2>
          <span className="wt-modal-sub">{task.title}</span>
        </div>

        <div className="wt-modal-body">
          <div className="wt-derived">
            <div className="wt-derived-row">
              <span className="wt-derived-key">Branch</span>
              <span className="wt-derived-val">{task.branch}</span>
            </div>
            <div className="wt-derived-row">
              <span className="wt-derived-key">Onto</span>
              <span className="wt-derived-val">
                origin/{task.baseBranch} <span className="wt-modal-sub">after a fetch, or {task.baseBranch} if there is no remote</span>
              </span>
            </div>
          </div>

          <div className="wt-field" style={{ marginTop: 14 }}>
            <span className="wt-label">
              {n === 1 ? 'This commit is reworded and rebased' : `These ${n} commits become one`}
            </span>
            <ul className="sq-commits">
              {commits.map((c) => (
                <li key={c.sha} className="sq-commit">
                  <span className="sq-sha">{c.sha.slice(0, 7)}</span>
                  <span className="sq-subject">{c.subject || '(no message)'}</span>
                  <span className="sq-when">{relativeTime(c.at, now)}</span>
                </li>
              ))}
            </ul>
          </div>

          {dirty && (
            <div className="wt-field" style={{ marginTop: 14 }}>
              <span className="wt-label">
                {uncommitted.length} uncommitted file{uncommitted.length === 1 ? '' : 's'}
              </span>
              <label className="wt-option" data-selected={!includeUncommitted}>
                <input type="radio" name="sq-dirty" checked={!includeUncommitted} onChange={() => setIncludeUncommitted(false)} />
                <span>
                  <span className="wt-option-label">Leave them out</span>
                  <span className="wt-option-detail">Stashed before the rebase and restored after it.</span>
                </span>
              </label>
              <label className="wt-option" data-selected={includeUncommitted}>
                <input type="radio" name="sq-dirty" checked={includeUncommitted} onChange={() => setIncludeUncommitted(true)} />
                <span>
                  <span className="wt-option-label">Include them</span>
                  <span className="wt-option-detail">Folded into the squashed commit.</span>
                </span>
              </label>
            </div>
          )}

          <label className="wt-check">
            <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
            <span>
              Push when done, with <span className="wt-mono">--force-with-lease</span>
            </span>
          </label>

          {error && (
            <div className="wt-error">
              <div className="wt-error-head">{error}</div>
            </div>
          )}
        </div>

        <div className="wt-modal-foot">
          <span className="wt-modal-sub">
            {direct
              ? 'Claude does the rebase, and stops to ask if a conflict is not obvious.'
              : 'The session is not idle, so the prompt goes to the message box to send when it is.'}
          </span>
          <span className="wt-foot-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || n === 0} onClick={() => void confirm()}>
            {busy ? 'Sending…' : direct ? 'Ask Claude to squash & rebase' : 'Put in message box'}
          </button>
        </div>
      </div>
    </div>
  );
}
