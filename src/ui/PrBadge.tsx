/**
 * Pull-request status for a task: a badge in the header, a mark on the row.
 *
 * Everything here is an ornament. With no `gh`, no login or no PR the
 * components render nothing at all -- no placeholder, no "unknown" -- because
 * a task without a PR is the normal case for most of its life.
 */

import { useEffect, useRef, useState } from 'react';
import type { Task } from '../types';
import { openExternal } from '../lib/openUrl';
import { getPrStatus, refreshPrStatus, usePrStatus, usePrStatusVersion } from '../gh/prStore';
import { prLookupBranch } from '../gh/gh';
import { commitsOnBranch } from '../git/worktree';
import { prLabel, prTooltip, type PrStatus } from '../gh/prStatus';
import './pr.css';

export interface PrBadgeProps {
  task: Task | null;
  /**
   * Opens the existing end-task dialog. Offered only once the PR is merged --
   * that is when the owner treats the conversation as done -- and never acted
   * on by itself: the dialog is where worktree removal is made safe, and
   * archiving is a decision, not a side effect of someone else's merge button.
   */
  onEnd?: (intent: 'archive' | 'delete') => void;
  /**
   * Opens the new-task dialog prefilled for a follow-up of this PR. Same
   * discipline as `onEnd`: offered once merged, and it only opens a dialog.
   */
  onFollowUp?: (pr: PrStatus) => void;
  /**
   * Asks Claude to open the PR, as the Files pane's Create PR does. Offered in
   * the badge's place once gh has answered that there is none and the branch
   * has commits of its own -- counted on the branch, wherever it is checked out.
   */
  onCreatePr?: () => void;
}

/** After a turn ends, when to look again for the checks a push started. */
const AFTER_TURN_RECHECK_MS = [10_000, 30_000];

/** Header badge: "#6 ✓ checks", "#6 ✗ 2 failing", "#6 merged  Archive… Delete…". */
export function PrBadge({ task, onEnd, onFollowUp, onCreatePr }: PrBadgeProps) {
  const pr = usePrStatus(task);
  // `undefined` is "gh has not answered yet": no button that a PR already
  // opened would make wrong. usePrStatus maps both to null, so its snapshot
  // does not change when gh answers "none" -- the version does, and is what
  // re-renders this when it does.
  usePrStatusVersion();

  // A turn that just ended is when a Create PR or a Push has just finished:
  // ask GitHub then, and again shortly after -- a push's checks are only
  // registered some seconds later, so the first answer still shows the last
  // run's result. Pending checks are then followed by the store's fast poll.
  const lastStatus = useRef(task?.status ?? null);
  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = task?.status ?? null;
    if (!task || was !== 'running' || task.status !== 'idle') return;
    void refreshPrStatus(task, { force: true });
    const timers = AFTER_TURN_RECHECK_MS.map((ms) =>
      window.setTimeout(() => void refreshPrStatus(task, { force: true }), ms),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [task?.id, task?.status]);

  const answered = task ? getPrStatus(task.id) !== undefined : false;
  const askable = !!task && !!onCreatePr && answered && pr === null && prLookupBranch(task) !== null;
  const [own, setOwn] = useState<number | null>(null);
  useEffect(() => {
    setOwn(null);
    if (!askable || !task) return;
    let live = true;
    void commitsOnBranch(task.repoPath, task.baseBranch, task.branch).then((n) => {
      if (live) setOwn(n);
    });
    return () => {
      live = false;
    };
  }, [askable, task?.id, task?.repoPath, task?.baseBranch, task?.branch, task?.lastActivityAt]);

  if (task && !pr && askable && own !== null && own > 0) {
    return (
      <span className="pr-badge-wrap">
        <button
          type="button"
          className="pr-badge"
          title={`No pull request yet. Ask Claude to open one into ${task.baseBranch} (${own} commit${own === 1 ? '' : 's'}). Sent at once (queued if Claude is working); while it waits on a permission prompt, it waits in the message box.`}
          onClick={onCreatePr}
        >
          Create PR
        </button>
      </span>
    );
  }
  if (!task || !pr) return null;
  const label = prLabel(pr);
  return (
    <span className="pr-badge-wrap">
      <button
        type="button"
        className="pr-badge"
        data-tone={label.tone}
        title={prTooltip(pr, { clickable: true })}
        aria-label={`Pull request ${pr.number}, ${label.text}. Open on GitHub`}
        onClick={() => void openExternal(pr.url)}
      >
        <span className="pr-num">#{pr.number}</span>
        {label.glyph && (
          <span className="pr-glyph" aria-hidden="true">
            {label.glyph}
          </span>
        )}
        <span>{label.text}</span>
      </button>
      {pr.state === 'merged' && onFollowUp && (
        // First: of the three, it is the one that starts work rather than
        // ending it.
        <button
          type="button"
          className="pr-end"
          title="Merged — start a new task for a bug in what shipped (opens the new-task dialog)"
          onClick={() => onFollowUp(pr)}
        >
          Follow-Up…
        </button>
      )}
      {pr.state === 'merged' && onEnd && (
        <>
          {/* Same verbs and ellipses as the row menu: both open the dialog,
              neither does anything by itself. */}
          <button
            type="button"
            className="pr-end"
            title="Merged — archive this task (opens the archive dialog)"
            onClick={() => onEnd('archive')}
          >
            Archive…
          </button>
          <button
            type="button"
            className="pr-end"
            data-tone="danger"
            title="Merged — delete this task; the conversation is kept (opens the delete dialog)"
            onClick={() => onEnd('delete')}
          >
            Delete…
          </button>
        </>
      )}
    </span>
  );
}
