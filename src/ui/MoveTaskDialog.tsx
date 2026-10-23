/**
 * Move a task between its worktree and the main checkout.
 *
 * The git side is src/git/moveTask.ts; this dialog says what will happen
 * before it does, the same way NewTaskDialog shows the worktree path it is
 * about to create. The session is the shell's: `onStop` ends it before git
 * runs, and `onDone` hands back the task's new place, where the shell resumes
 * the same session.
 *
 * Owner: worktree workstream (M3).
 */

import { useCallback, useEffect, useState } from 'react';
import type { Project, Task } from '../types';
import { updateTask } from '../db';
import { listBranches } from '../git/worktree';
import { planMove, runMove, type MovePlan } from '../git/moveTask';
import { stopPhpantom } from '../lsp/phpantom';
import { wrapForTooltip } from './text';
import './worktree.css';

export interface MoveTaskDialogProps {
  /** The task to move; null closes the dialog. */
  task: Task | null;
  project: Project | null;
  onClose: () => void;
  /** End the task's session, and resolve once it is gone. */
  onStop: (task: Task) => Promise<void>;
  /**
   * The move is over. `moved` is the row as it is now -- in its new place, or
   * unchanged after a failure -- and the session starts again either way.
   */
  onDone: (moved: Task) => void;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function MoveTaskDialog({ task, project, onClose, onStop, onDone }: MoveTaskDialogProps) {
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [backTo, setBackTo] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Moved, but the carried changes could not be applied: they wait here. */
  const [stashLeft, setStashLeft] = useState<string | null>(null);

  const open = task !== null;

  useEffect(() => {
    setPlan(null);
    setError(null);
    setStashLeft(null);
    setBackTo(null);
    if (!task) return;
    void listBranches(task.repoPath).then(
      (b) => setBranches(b.locals.filter((x) => x !== task.branch)),
      () => setBranches([]),
    );
  }, [task]);

  useEffect(() => {
    if (!task) return;
    let live = true;
    void (async () => {
      const { homeDir } = await import('@tauri-apps/api/path');
      const home = await homeDir().catch(() => '');
      const p = await planMove(task, {
        busy: task.status === 'running' || task.status === 'blocked',
        worktreeRoot: project?.worktreeRoot ?? null,
        home,
        mainBackTo: backTo,
      });
      if (live) setPlan(p);
    })();
    return () => {
      live = false;
    };
  }, [task, project, backTo]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  const move = useCallback(async () => {
    if (!task || !plan || plan.blockers.length > 0 || busy) return;
    setBusy(true);
    setError(null);
    let r: Awaited<ReturnType<typeof runMove>>;
    try {
      await onStop(task);
      // Its watcher holds the old folder, and the folder may be about to go.
      await stopPhpantom(task.worktreePath).catch(() => {});
      r = await runMove(plan, task.repoPath, task.id);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
      onDone(task); // nothing moved: start the session again where it was
      return;
    }
    // git has moved: from here the task is in its new place whatever else
    // fails, or its session would restart in a folder that may be gone.
    const moved = { ...task, worktreePath: r.worktreePath, ownsWorktree: r.ownsWorktree };
    let saved = true;
    try {
      await updateTask(task.id, { worktreePath: r.worktreePath, ownsWorktree: r.ownsWorktree });
    } catch (e) {
      saved = false;
      setError(
        `The move happened, but the task could not be saved:\n${messageOf(e)}\n\n` +
          `It is in ${r.worktreePath} until Albedo restarts. Move it again then.`,
      );
    }
    setBusy(false);
    onDone(moved);
    if (r.stashLeft) setStashLeft(r.stashLeft);
    else if (saved) onClose();
  }, [task, plan, busy, onStop, onDone, onClose]);

  if (!task) return null;

  const toMain = plan?.direction === 'to-main';
  const title = !plan ? 'Move Task' : toMain ? 'Move to Main Checkout' : 'Move to a Worktree';

  return (
    <div
      className="wt-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="wt-modal" role="dialog" aria-modal="true" aria-labelledby="wt-move-title">
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="wt-move-title">
            {title}
          </h2>
          <span className="wt-modal-sub wt-modal-task" title={wrapForTooltip(task.title)}>
            {task.title}
          </span>
        </div>

        <div className="wt-modal-body">
          {!plan ? (
            <div className="wt-hint">Reading the worktree and the main checkout…</div>
          ) : (
            <>
              <div className="wt-derived">
                <div className="wt-derived-row">
                  <span className="wt-derived-key">Branch</span>
                  <span className="wt-derived-val">{plan.branch || '—'}</span>
                </div>
                <div className="wt-derived-row">
                  <span className="wt-derived-key">From</span>
                  <span className="wt-derived-val">{plan.from}</span>
                </div>
                <div className="wt-derived-row">
                  <span className="wt-derived-key">To</span>
                  <span className="wt-derived-val" data-pending={!plan.to}>
                    {plan.to || '—'}
                  </span>
                </div>
              </div>

              {!toMain && (
                <div className="wt-field">
                  <label className="wt-label" htmlFor="wt-move-back">
                    Main Checkout Goes Back To
                  </label>
                  <select
                    id="wt-move-back"
                    className="wt-select"
                    value={plan.mainBackTo ?? ''}
                    disabled={busy || branches.length === 0}
                    onChange={(e) => setBackTo(e.target.value)}
                  >
                    {!plan.mainBackTo && <option value="">—</option>}
                    {branches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  <div className="wt-hint">git checks a branch out in one place at a time.</div>
                </div>
              )}

              <ol className="wt-steps">
                <li>The session stops, and picks up again in the new place, with its conversation.</li>
                {plan.carry > 0 && (
                  <li>
                    {plan.carry} uncommitted change{plan.carry === 1 ? '' : 's'} come along: stashed here,
                    applied there.
                  </li>
                )}
                {toMain ? (
                  <>
                    <li>
                      {plan.oldFolder === 'remove'
                        ? 'The worktree is removed. Its branch and commits stay.'
                        : 'The folder stays, on a detached HEAD: Albedo did not create it.'}
                    </li>
                    <li>
                      {plan.switchMain
                        ? `The main checkout switches to ${plan.branch}.`
                        : `The main checkout is on ${plan.branch} already: the task is pointed there.`}
                    </li>
                  </>
                ) : (
                  <>
                    <li>The main checkout switches to {plan.mainBackTo ?? '…'}.</li>
                    <li>A worktree is created on {plan.branch}.</li>
                  </>
                )}
              </ol>

              {plan.blockers.length > 0 && (
                <div className="wt-error">
                  <div className="wt-error-head">Cannot move yet</div>
                  <ul className="wt-blockers">
                    {plan.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {error && (
            <div className="wt-error">
              <div className="wt-error-head">The move did not happen</div>
              <pre className="wt-error-body">{error}</pre>
            </div>
          )}
          {stashLeft && (
            <div className="wt-error">
              <div className="wt-error-head">Moved, but the uncommitted changes did not apply</div>
              <pre className="wt-error-body">
                {`They are kept in a stash. In ${plan?.to ?? 'the new folder'} run:\n  git stash apply ${stashLeft}`}
              </pre>
            </div>
          )}
        </div>

        <div className="wt-modal-foot">
          <span className="wt-foot-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {stashLeft ? 'Close' : 'Cancel'}
          </button>
          {!stashLeft && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!plan || plan.blockers.length > 0 || busy}
              onClick={() => void move()}
            >
              {busy ? 'Moving…' : 'Move'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
