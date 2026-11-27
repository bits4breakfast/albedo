/**
 * "Create PR without Review…" (#464): the way past the review gate, asked
 * once more. It says what is left of the review, and that the PR is the same
 * draft-first one Create PR opens -- marked ready for review when its checks
 * pass, without waiting on the guide. Confirming sends the same prompt.
 */

import { useEffect } from 'react';
import type { Task } from '../types';
import { gateReason, type ReviewGate } from '../guide/gate';
import { wrapForTooltip } from './text';
import './worktree.css';

export interface UnreviewedPrDialogProps {
  task: Pick<Task, 'title' | 'branch' | 'baseBranch'>;
  /** Where the review stands; null when not known. */
  gate: ReviewGate | null;
  /** The base the PR goes into, as the header shows it. */
  base: string;
  onConfirm: () => void;
  onClose: () => void;
}

export default function UnreviewedPrDialog({ task, gate, base, onConfirm, onClose }: UnreviewedPrDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
        aria-labelledby="unreviewed-pr-title"
        aria-describedby="unreviewed-pr-why"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="unreviewed-pr-title">
            Create PR Without Review?
          </h2>
          <span className="wt-modal-sub wt-modal-task" title={wrapForTooltip(task.title)}>
            {task.title}
          </span>
        </div>

        <div className="wt-modal-body">
          <p className="wt-modal-sub" id="unreviewed-pr-why">
            {gate ? gateReason(gate) : 'The Review Guide has not been checked for this branch.'} Create PR normally waits
            until every group in the guide is Reviewed for the branch as it is now.
          </p>
          <div className="wt-derived">
            <div className="wt-derived-row">
              <span className="wt-derived-key">Branch</span>
              <span className="wt-derived-val">{task.branch}</span>
            </div>
            <div className="wt-derived-row">
              <span className="wt-derived-key">Into</span>
              <span className="wt-derived-val">{base || task.baseBranch}</span>
            </div>
          </div>
        </div>

        <div className="wt-modal-foot">
          <span className="wt-modal-sub">Claude opens it as a draft; Albedo marks it ready for review when its checks pass.</span>
          <span className="wt-foot-spacer" />
          {/* Focus on Cancel: skipping the review is the choice made on purpose. */}
          <button type="button" className="btn btn-ghost" onClick={onClose} autoFocus>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Create PR
          </button>
        </div>
      </div>
    </div>
  );
}

