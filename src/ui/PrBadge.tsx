/**
 * Pull-request status for a task: a badge in the header, a mark on the row.
 *
 * The status is an ornament. With no `gh`, no login or no PR the
 * components render nothing at all -- no placeholder, no "unknown" -- because
 * a task without a PR is the normal case for most of its life.
 *
 * One action rides on it (#236), chosen by `prAction`: Squash and Merge…,
 * which Albedo runs through gh after a confirm (MergeDialog), or ⚠ Conflicts,
 * which hands Claude the rebase. Nothing when neither applies.
 */

import { useEffect, useRef, useState } from 'react';
import type { OpenFileRequest, Task } from '../types';
import { openExternal } from '../lib/openUrl';
import { getPrStatus, refreshPrStatus, usePrStatus, usePrStatusVersion, useViewerLogin } from '../gh/prStore';
import { prLookupBranch } from '../gh/gh';
import { commitsOnBranch } from '../git/worktree';
import { prLabel, prTooltip, reviewChip, reviewTooltip, type PrStatus } from '../gh/prStatus';
import ChecksDialog from './ChecksDialog';
import MergeDialog from './MergeDialog';
import { prAction } from '../gh/prAction';
import { ciCueFor, takeChecksRequest, useCiVersion } from './ciNotice';
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
  /** Opens a check annotation's file at its line (the Checks dialog). */
  onOpenFile?: (request: OpenFileRequest) => void;
  /**
   * Asks Claude to rebase onto the base and resolve the conflicts GitHub
   * reports (#236), as the other git buttons do: a prompt, sent at once or
   * held while a turn runs. Albedo runs no git for it.
   */
  onResolveConflicts?: (pr: PrStatus) => void;
}

/**
 * Does the badge open the Checks dialog, or the PR on GitHub? The dialog
 * while the PR is open and has checks to show; once merged or closed the
 * checks no longer matter, and the badge opens GitHub as it always did.
 */
export function opensChecks(pr: PrStatus): boolean {
  return (pr.state === 'open' || pr.state === 'draft') && pr.lines.length > 0;
}

/** After a turn ends, when to look again for the checks a push started. */
const AFTER_TURN_RECHECK_MS = [10_000, 30_000];

/** Header badge: "#6 ✓ checks", "#6 ✗ 2 failing", "#6 merged  Archive… Delete…". */
export function PrBadge({ task, onEnd, onFollowUp, onCreatePr, onOpenFile, onResolveConflicts }: PrBadgeProps) {
  const pr = usePrStatus(task);
  const [checksOpen, setChecksOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const badgeRef = useRef<HTMLButtonElement>(null);
  // Another task's PR is another dialog: never carry one over a switch.
  useEffect(() => {
    setChecksOpen(false);
    setMergeOpen(false);
  }, [task?.id]);
  // A click on a "checks failed" banner opens the task, then this (#159).
  // After the reset above, which a switch to that task also runs.
  const ciVersion = useCiVersion();
  useEffect(() => {
    if (task && pr && opensChecks(pr) && takeChecksRequest(task.id)) setChecksOpen(true);
  }, [task?.id, pr, ciVersion]);
  // `undefined` is "gh has not answered yet": no button that a PR already
  // opened would make wrong. usePrStatus maps both to null, so its snapshot
  // does not change when gh answers "none" -- the version does, and is what
  // re-renders this when it does.
  usePrStatusVersion();
  // Whose PR this is decides whether "Awaiting Review" is worth showing.
  // Asked only once there is an open PR to show a chip for.
  const viewer = useViewerLogin(pr?.state === 'open', task?.id ?? null);

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
  const checks = opensChecks(pr);
  // Checks finished while this task was open: a brief ring, and words for a
  // screen reader (ciNotice.ts). The badge itself already shows the result.
  const cue = ciCueFor(task.id);
  return (
    <span className="pr-badge-wrap">
      <button
        ref={badgeRef}
        type="button"
        className="pr-badge"
        data-tone={label.tone}
        data-cue={cue ?? undefined}
        title={checks ? `${prTooltip(pr)}\nClick to see the checks` : prTooltip(pr, { clickable: true })}
        aria-label={`Pull request ${pr.number}, ${label.text}. ${checks ? 'Show the checks' : 'Open on GitHub'}`}
        aria-haspopup={checks ? 'dialog' : undefined}
        onClick={() => (checks ? setChecksOpen(true) : void openExternal(pr.url))}
      >
        <span className="pr-num">#{pr.number}</span>
        {label.glyph && (
          <span className="pr-glyph" aria-hidden="true">
            {label.glyph}
          </span>
        )}
        <span>{label.text}</span>
      </button>
      {pr.state === 'open' && <ReviewChip pr={pr} viewer={viewer} />}
      <PrActionControl pr={pr} onMerge={() => setMergeOpen(true)} onResolveConflicts={onResolveConflicts} />
      {mergeOpen && <MergeDialog task={task} pr={pr} onClose={() => setMergeOpen(false)} />}
      <span className="sr-only" role="status">
        {cue ? `Checks ${cue === 'pass' ? 'passed' : 'failed'} on pull request ${pr.number}` : ''}
      </span>
      {checksOpen && checks && (
        <ChecksDialog
          task={task}
          pr={pr}
          onOpenFile={onOpenFile}
          onClose={() => {
            setChecksOpen(false);
            badgeRef.current?.focus();
          }}
        />
      )}
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

/**
 * The PR's one action, after the review chip (#236): Squash and Merge… when
 * it is approved, green and clean; ⚠ Conflicts when GitHub reports them; or,
 * approved but not mergeable yet, GitHub's reason in words -- never a
 * disabled button. Nothing otherwise (`prAction`).
 */
function PrActionControl({
  pr,
  onMerge,
  onResolveConflicts,
}: {
  pr: PrStatus;
  onMerge: () => void;
  onResolveConflicts?: (pr: PrStatus) => void;
}) {
  const action = prAction(pr);
  if (!action) return null;
  if (action.kind === 'conflicts') {
    if (!onResolveConflicts) return null;
    return (
      <button
        type="button"
        className="pr-action"
        data-tone="conflicts"
        title={`GitHub reports conflicts with ${pr.baseRefName || 'the base'}. Ask Claude to rebase onto it, resolve them, run the tests and push. Sent at once (queued if Claude is working).`}
        onClick={() => onResolveConflicts(pr)}
      >
        <span aria-hidden="true">⚠</span> Conflicts
      </button>
    );
  }
  if (action.kind === 'merge') {
    return (
      <button
        type="button"
        className="pr-action"
        data-tone="merge"
        title={`Approved, checks pass, no conflicts: squash and merge PR #${pr.number} into ${pr.baseRefName || 'its base'} (asks first)`}
        aria-haspopup="dialog"
        onClick={onMerge}
      >
        Squash and Merge…
      </button>
    );
  }
  return (
    <span className="pr-reason" title={`GitHub's merge state: ${pr.mergeState ?? 'unknown'}`}>
      {action.reason}
    </span>
  );
}

/**
 * The review chip beside the PR badge (#180): a second fact, so checks and
 * review never share one label. Approved in the pass tone, Changes Requested
 * in the warn tone, Awaiting Review quiet; each with a glyph and the words, as
 * the badge. Nothing for a draft, merged or closed PR, for a PR nobody needs
 * to review, or for the owner's own PR when nobody was asked (`reviewChip`).
 * A click opens the PR on GitHub, where the reviews are; the tooltip names
 * the reviewers.
 */
function ReviewChip({ pr, viewer }: { pr: PrStatus; viewer: string | null }) {
  const chip = reviewChip(pr, viewer);
  if (!chip) return null;
  return (
    <button
      type="button"
      className="pr-badge pr-review"
      data-tone={chip.tone}
      data-review={chip.kind}
      title={reviewTooltip(pr)}
      aria-label={`Review: ${chip.text}. Open the reviews on GitHub`}
      onClick={() => void openExternal(pr.url)}
    >
      <span className="pr-glyph" aria-hidden="true">
        {chip.glyph}
      </span>
      <span>{chip.text}</span>
    </button>
  );
}
