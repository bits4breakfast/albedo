/**
 * Confirm a squash and merge before Albedo runs it (#236).
 *
 * The one GitHub write Albedo makes itself, by the owner's decision: an
 * approved, green, clean PR needs no judgement, so a prompt to Claude would
 * only cost a turn. It shows what it acts on -- the PR, the branch and its
 * base, how many commits become one -- and takes the one decision gh needs:
 * whether to delete the branch on GitHub afterwards (remembered).
 *
 * Never `--admin`. A refusal is GitHub's own message, shown here; nothing else
 * happens. A merge never archives, removes or switches anything: the worktree
 * and the task stay, and Archive… stays a decision (PrBadge).
 */

import { useEffect, useRef, useState } from 'react';
import type { Task } from '../types';
import type { PrStatus } from '../gh/prStatus';
import { mergePr } from '../gh/gh';
import { refreshPrStatus } from '../gh/prStore';
import { commitsOnBranch } from '../git/worktree';
import { flagCodec, KEYS, readPersisted, writePersisted } from './persisted';
import { wrapForTooltip } from './text';
import './worktree.css';

export interface MergeDialogProps {
  task: Task;
  pr: PrStatus;
  onClose: () => void;
}

export default function MergeDialog({ task, pr, onClose }: MergeDialogProps) {
  const [deleteBranch, setDeleteBranch] = useState(() => readPersisted(KEYS.mergeDeleteBranch, flagCodec, true));
  const [commits, setCommits] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const base = pr.baseRefName || task.baseBranch;

  useEffect(() => {
    let live = true;
    void commitsOnBranch(task.repoPath, base, task.branch)
      .then((n) => {
        if (live) setCommits(n);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [task.repoPath, base, task.branch]);

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

  const confirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    writePersisted(KEYS.mergeDeleteBranch, flagCodec, deleteBranch);
    try {
      const out = await mergePr(pr, task, { deleteBranch });
      // The task that asked, whatever is on screen now: its badge turns
      // "merged" from GitHub's answer, not from this one.
      void refreshPrStatus(task, { force: true });
      if (out.ok) {
        if (out.branchNotDeleted) console.warn('[merge] merged; the branch was not deleted:', out.branchNotDeleted);
        onClose();
      } else {
        setError(out.message);
      }
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
        aria-labelledby="merge-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="merge-title">
            Squash and Merge PR #{pr.number}?
          </h2>
          <span className="wt-modal-sub wt-modal-task" title={wrapForTooltip(pr.title || task.title)}>
            {pr.title || task.title}
          </span>
        </div>

        <div className="wt-modal-body">
          <div className="wt-derived">
            <div className="wt-derived-row">
              <span className="wt-derived-key">Branch</span>
              <span className="wt-derived-val">{pr.headRefName || task.branch}</span>
            </div>
            <div className="wt-derived-row">
              <span className="wt-derived-key">Into</span>
              <span className="wt-derived-val">{base}</span>
            </div>
            {commits !== null && commits > 0 && (
              <div className="wt-derived-row">
                <span className="wt-derived-key">Commits</span>
                <span className="wt-derived-val">
                  {commits === 1 ? '1 commit, squashed' : `${commits} commits become one`}
                </span>
              </div>
            )}
          </div>

          <label className="wt-check">
            <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
            <span>Delete the branch on GitHub after merging</span>
          </label>

          {error && (
            <div className="wt-error" role="alert">
              <div className="wt-error-head">GitHub did not merge it</div>
              <pre className="wt-error-body">{error}</pre>
            </div>
          )}
        </div>

        <div className="wt-modal-foot">
          <span className="wt-modal-sub">The worktree and the task stay; Archive… is yours to choose after.</span>
          <span className="wt-foot-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Merging…' : 'Squash and Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}
