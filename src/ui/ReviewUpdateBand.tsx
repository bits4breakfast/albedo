/**
 * The band over a review task's tabs (#352): the PR moved on GitHub after the
 * copy was checked out, and Update Copy brings the copy up to it.
 *
 *   behind      "3 new commits on GitHub · since your copy · latest 2h ago by
 *               <author>"  [Update Copy]          on --info-band
 *   force-push  "Force-pushed on GitHub" and what Update Copy would do
 *               [Update Copy]                     on --banner-bg
 *   failed      "Couldn't update" with git's words, "Your copy is unchanged."
 *               [Show in Files]                   on --banner-bg
 *
 * Shown only while GitHub's head is not the copy's HEAD (or a failure or
 * "already up to date" waits to be read). New comments alone never show it:
 * they need no update. GitHub's head is the Reviewing tab's last answer, so
 * nothing here polls; the copy's HEAD is read with git when that answer
 * changes. Nothing updates on its own.
 */

import type { ReactNode } from 'react';
import type { Task } from '../types';
import { reviewListState, useReviewsVersion } from '../gh/reviewStore';
import type { ReviewPr } from '../gh/reviewRequests';
import {
  behindWords,
  dismissUpdateNotice,
  isUpdating,
  runReviewUpdate,
  updateFailureOf,
  useCopyBehind,
  useSinceReviewVersion,
  wasUpToDate,
} from '../guide/copyUpdate';
import { relativeTime } from './TaskList';
import '../guide/guide.css';
import './reviewupdate.css';

/** The PR of a review task, from the Reviewing tab's last answer; null when not listed. */
export function usePrOfReview(task: Pick<Task, 'repoPath' | 'reviewUrl'> | null): ReviewPr | null {
  useReviewsVersion();
  if (!task?.reviewUrl) return null;
  const s = reviewListState(task.repoPath);
  return s.kind === 'ready' ? (s.list.prs.find((p) => p.url === task.reviewUrl) ?? null) : null;
}

function ago(at: number, now: number): string {
  const r = relativeTime(at, now);
  return r === 'now' ? 'just now' : `${r} ago`;
}

export interface ReviewUpdateBandProps {
  task: Task;
  /** Show the Files tab: where the copy's local edits are, after a failure. */
  onShowFiles: () => void;
  /** Now, ms; a test seam. */
  now?: number;
}

export default function ReviewUpdateBand({ task, onShowFiles, now }: ReviewUpdateBandProps): ReactNode {
  useSinceReviewVersion();
  const pr = usePrOfReview(task);
  const behind = useCopyBehind(task, pr);
  if (!task.reviewUrl) return null;
  const busy = isUpdating(task.id);
  const failure = updateFailureOf(task.id);
  const update = () => void runReviewUpdate(task);

  if (failure !== null && !busy) {
    return (
      <div className="rv-band" data-tone="warn" role="alert">
        <b className="rv-band-title">Couldn’t update</b>
        <span className="rv-band-sub">
          git: “{failure}” Your copy is unchanged.
        </span>
        <span className="rv-band-gap" />
        <button type="button" className="gd-btn" onClick={onShowFiles} title="See the copy’s local changes in the Files tab">
          Show in Files
        </button>
        <button type="button" className="gd-btn" onClick={() => dismissUpdateNotice(task.id)}>
          Dismiss
        </button>
      </div>
    );
  }

  const button = (
    <button
      type="button"
      className="gd-btn gd-btn-primary"
      onClick={update}
      disabled={busy}
      aria-busy={busy || undefined}
      title="Fetch the pull request’s head from GitHub and move your copy to it"
    >
      {busy ? 'Updating…' : 'Update Copy'}
    </button>
  );

  if (behind) {
    const t = now ?? Date.now();
    if (behind.forced) {
      return (
        <div className="rv-band" data-tone="warn" role="status">
          <b className="rv-band-title">Force-pushed on GitHub</b>
          <span className="rv-band-sub">
            Update Copy would replace your copy’s history. Your local edits are kept, or the update stops with git’s
            message.
          </span>
          <span className="rv-band-gap" />
          {button}
        </div>
      );
    }
    const latest = [
      'since your copy',
      behind.latestAt !== null ? `latest ${ago(behind.latestAt, t)}${behind.author ? ` by ${behind.author}` : ''}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <div className="rv-band" role="status">
        <b className="rv-band-title">{behindWords(behind)} on GitHub</b>
        <span className="rv-band-sub">{latest}</span>
        <span className="rv-band-gap" />
        {button}
      </div>
    );
  }

  if (busy) {
    // From the task's menu, with the copy not known to be behind.
    return (
      <div className="rv-band" role="status">
        <b className="rv-band-title">Updating your copy from GitHub…</b>
        <span className="rv-band-gap" />
        {button}
      </div>
    );
  }

  if (wasUpToDate(task.id)) {
    return (
      <div className="rv-band" role="status">
        <b className="rv-band-title">Your copy is up to date</b>
        <span className="rv-band-sub">It is already at the pull request’s head on GitHub.</span>
        <span className="rv-band-gap" />
        <button type="button" className="gd-btn" onClick={() => dismissUpdateNotice(task.id)}>
          OK
        </button>
      </div>
    );
  }
  return null;
}
