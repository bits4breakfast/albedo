/**
 * Pull-request status for a task: a badge in the header, a mark on the row.
 *
 * Everything here is an ornament. With no `gh`, no login or no PR the
 * components render nothing at all -- no placeholder, no "unknown" -- because
 * a task without a PR is the normal case for most of its life.
 */

import type { Task } from '../types';
import { openExternal } from '../lib/openUrl';
import { usePrStatus } from '../gh/prStore';
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
}

/** Header badge: "#6 ✓ checks", "#6 ✗ 2 failing", "#6 merged  Archive… Delete…". */
export function PrBadge({ task, onEnd, onFollowUp }: PrBadgeProps) {
  const pr = usePrStatus(task);
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
          Follow-up…
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
 * Sidebar mark. Text-sized and non-interactive -- the row is the click target
 * -- so it is read like the context readout beside it: glyph first, number
 * after, detail in the tooltip.
 */
export function PrRowMark({ pr }: { pr: PrStatus | null | undefined }) {
  if (!pr) return null;
  const label = prLabel(pr);
  const short =
    pr.state === 'merged'
      ? 'merged'
      : pr.checks.kind === 'failing'
        ? `✗${pr.checks.failing}`
        : label.glyph;
  return (
    <span className="pr-mark" data-tone={label.tone} title={prTooltip(pr)}>
      {short && <span className="pr-mark-state">{short}</span>}
      <span>#{pr.number}</span>
    </span>
  );
}
