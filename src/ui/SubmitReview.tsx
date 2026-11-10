/**
 * Submit Review (#287, step 3): a review task's one main action, and the
 * dialog it opens.
 *
 * The task bar shows the review task's PR as `#n on GitHub`; Submit Review
 * sits beside it, as Merge sits beside your own PR's badge, with the number
 * of drafts waiting riding on it. The dialog takes a summary and a verdict
 * (Comment, Approve, Request Changes), says what goes out, and sends it as
 * one review through gh (reviewSubmit.ts). Albedo posts nothing else, and
 * only from this click: the review session never posts.
 *
 * A failure keeps every draft GitHub did not accept, and the dialog says
 * what went and what did not. When the review went and a reply did not,
 * the next click sends only the replies, so nothing is posted twice.
 */

import { GitHubIcon } from './icons';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '../types';
import { openExternal } from '../lib/openUrl';
import {
  cannotSubmit,
  failureAdvice,
  planReview,
  submitReview,
  VERDICT_LABEL,
  type ReviewVerdict,
  type SubmitOutcome,
} from '../gh/reviewSubmit';
import { refreshThreads } from '../gh/reviewThreads';
import { refreshReviews, reviewListState, useReviewsVersion } from '../gh/reviewStore';
import { prepareSubmit, reviewPr, submitIo, useGithubDrafts, type SubmitInput } from './reviewDrafts';
import { wrapForTooltip } from './text';
import './worktree.css';

// ---------------------------------------------------------------------------
// Open requests: the task bar's button, and the Files pane's Submit…
// ---------------------------------------------------------------------------

let requested: number | null = null;
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const l of [...listeners]) l();
}

/** Open the Submit Review dialog for this task (from anywhere that lists its drafts). */
export function requestSubmitReview(taskId: number): void {
  requested = taskId;
  notify();
}

function useSubmitState(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}

/** @internal Test seam: no dialog asked for, nothing in flight. */
export function resetSubmitRequestForTests(): void {
  requested = null;
  summaries.clear();
  sending.clear();
  reviewPosted.clear();
}

/** Close the dialog -- only if it is still this task's: a send that ends late never closes another's. */
function clearRequest(taskId: number): void {
  if (requested !== taskId) return;
  requested = null;
  notify();
}

/** What you typed in the summary, per task, until it is sent or the app quits. */
const summaries = new Map<number, string>();
/**
 * Tasks whose review is being sent right now. Kept per task, not per
 * dialog: the dialog unmounts when you switch task, and a send it started
 * keeps running. Back on the task, a fresh dialog must see that send still
 * going -- Submit off, "Sending…" -- or a second click would post the same
 * review twice.
 */
const sending = new Set<number>();
/** Tasks whose review went out while some replies did not: only replies are left. */
const reviewPosted = new Set<number>();

// ---------------------------------------------------------------------------
// The badge and the action
// ---------------------------------------------------------------------------

/**
 * `#n on GitHub` and Submit Review, for the task bar of a review task. The
 * count is the drafts (line comments and replies) waiting to go.
 */
export function ReviewBadge({ task }: { task: Task }): ReactNode {
  const drafts = useGithubDrafts(task);
  useSubmitState();
  const open = requested === task.id;
  // Another task selected: its dialog is not asked for any more. Coming
  // back does not open it again on its own.
  useEffect(() => () => clearRequest(task.id), [task.id]);
  const number = /\/pull\/(\d+)/.exec(task.reviewUrl ?? '')?.[1];
  if (!task.reviewUrl) return null;
  return (
    <span className="pr-badge-wrap">
      <button
        type="button"
        className="pr-badge"
        title={`${task.reviewUrl}\nOpen on GitHub`}
        aria-label={`#${number} on GitHub`}
        onClick={() => void openExternal(task.reviewUrl!)}
      >
        {/* GitHub's mark where "on GitHub" was (#317): the bar's room goes
            to the title and branch; the label still says it. */}
        <GitHubIcon />
        <span className="pr-num">#{number}</span>
      </button>
      <button
        type="button"
        className="pr-action"
        data-tone="submit"
        onClick={() => requestSubmitReview(task.id)}
        title={
          drafts.length > 0
            ? `${drafts.length === 1 ? '1 draft' : `${drafts.length} drafts`} for GitHub. Send them as one review, with a summary and a verdict`
            : 'Send a review: a summary and a verdict, with any drafts you write on the code'
        }
      >
        Submit Review{drafts.length > 0 ? ` · ${drafts.length}` : ''}
      </button>
      {open ? <SubmitReviewDialog task={task} onClose={() => clearRequest(task.id)} /> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

type Loaded = { kind: 'loading' } | { kind: 'ready'; input: SubmitInput } | { kind: 'failed'; message: string };

const VERDICTS: ReviewVerdict[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

export function SubmitReviewDialog({ task, onClose }: { task: Task; onClose: () => void }): ReactNode {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [summary, setSummaryState] = useState(() => summaries.get(task.id) ?? '');
  const [verdict, setVerdict] = useState<ReviewVerdict>('COMMENT');
  useSubmitState();
  const busy = sending.has(task.id);
  const [outcome, setOutcome] = useState<Extract<SubmitOutcome, { ok: false }> | null>(null);
  // Once the review itself is on GitHub, only replies are left to send.
  const reviewDone = reviewPosted.has(task.id);
  const pr = reviewPr(task);
  useReviewsVersion();
  const dialogRef = useRef<HTMLDivElement>(null);

  const setSummary = (v: string) => {
    summaries.set(task.id, v);
    setSummaryState(v);
  };

  const load = () => {
    setLoaded({ kind: 'loading' });
    prepareSubmit(task).then(
      (input) => setLoaded({ kind: 'ready', input }),
      (err: unknown) => setLoaded({ kind: 'failed', message: err instanceof Error ? err.message : String(err) }),
    );
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [task.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Ours either way: the editor closes its file on Escape from a window
      // listener of its own. Capture, as the other dialogs do.
      e.stopPropagation();
      if (!sending.has(task.id)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, task.id]);

  // The keyboard comes into the dialog, and goes back to where it was when
  // the dialog closes (as What's New does).
  const [from] = useState(() => document.activeElement);
  useEffect(() => {
    dialogRef.current?.focus();
    return () => {
      if (from instanceof HTMLElement && from.isConnected) from.focus();
    };
  }, [from]);

  const input = loaded.kind === 'ready' ? loaded.input : null;
  const plan = useMemo(() => {
    if (!input) return null;
    const p = planReview({ drafts: input.drafts, ranges: input.ranges, summary, verdict, commitId: input.commitId });
    return reviewDone ? { ...p, review: null, inReview: [], outside: [] } : p;
  }, [input, summary, verdict, reviewDone]);

  // The PR's head on GitHub, from the Reviewing list's last answer: no
  // request of its own. Unknown says nothing.
  const listed = (() => {
    const s = reviewListState(task.repoPath);
    return s.kind === 'ready' ? (s.list.prs.find((p) => p.url === task.reviewUrl) ?? null) : null;
  })();
  const moved = input !== null && listed !== null && listed.headOid !== '' && listed.headOid !== input.commitId;
  // How it moved, from what the list and git already have: more commits on
  // GitHub than here is "N new commits"; anything else is a rewrite.
  const newCommits = moved && input.localCommits !== null ? listed.commitCount - input.localCommits : 0;
  const movedWords =
    newCommits > 0 ? `${plural(newCommits, 'new commit', 'new commits')} on GitHub` : 'The pull request has moved on GitHub';

  const lines = plan?.review?.comments.length ?? 0;
  const outside = plan?.outside.length ?? 0;
  const replies = plan?.replies.length ?? 0;
  const why = input && !reviewDone ? cannotSubmit(input.drafts.filter((d) => d.replyTo === null), summary, verdict) : null;
  const nothing = plan !== null && plan.review === null && replies === 0;

  const send = async () => {
    if (sending.has(task.id) || !plan || !pr) return;
    const id = task.id;
    sending.add(id);
    notify();
    setOutcome(null);
    try {
      const out = await submitReview(pr, plan, submitIo(task));
      // What was posted shows as threads, whatever happened after it.
      if (out.ok || out.reviewSent || out.repliesSent > 0) {
        void refreshThreads(task.reviewUrl!, pr, task.worktreePath, { force: true });
      }
      // A submitted review or reply moves the PR out of Review Started
      // (#315): ask for the list now rather than at the next minute's poll.
      if (out.ok || out.reviewSent || out.repliesSent > 0) void refreshReviews(task.repoPath, { force: true });
      if (out.ok) {
        summaries.delete(id);
        reviewPosted.delete(id);
        clearRequest(id);
        return;
      }
      if (out.reviewSent && plan.review !== null) {
        reviewPosted.add(id);
        summaries.delete(id);
      }
      setOutcome(out);
      load();
    } finally {
      sending.delete(id);
      notify();
    }
  };

  const action = reviewDone ? `Send ${plural(replies, 'Reply', 'Replies')}` : outcome ? 'Submit Again' : 'Submit Review';

  return (
    <div
      className="wt-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !sending.has(task.id)) onClose();
      }}
    >
      <div
        className="wt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="submit-review-title"
        ref={dialogRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wt-modal-head">
          <h2 className="wt-modal-title" id="submit-review-title">
            Submit Review
          </h2>
          <span className="wt-modal-sub wt-modal-task" title={wrapForTooltip(task.title)}>
            #{pr?.number} {task.title}
          </span>
        </div>

        <div className="wt-modal-body">
          {loaded.kind === 'loading' ? <div className="wt-hint">Reading your drafts…</div> : null}
          {loaded.kind === 'failed' ? (
            <div className="wt-error" role="alert">
              <div className="wt-error-head">Could not read the review</div>
              <pre className="wt-error-body">{loaded.message}</pre>
            </div>
          ) : null}

          {input && plan && !reviewDone ? (
            <>
              <div className="wt-field">
                <label className="wt-label" htmlFor="submit-review-summary">
                  Summary<span className="wt-label-optional">optional</span>
                </label>
                <textarea
                  id="submit-review-summary"
                  className="wt-input wt-textarea"
                  value={summary}
                  disabled={busy}
                  onChange={(e) => setSummary(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !why && !nothing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
              </div>
              <div className="wt-field">
                <span className="wt-label" id="submit-review-verdict">
                  Verdict
                </span>
                <div className="wt-seg" role="radiogroup" aria-labelledby="submit-review-verdict">
                  {VERDICTS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      className="wt-seg-option"
                      aria-checked={verdict === v}
                      disabled={busy}
                      onClick={() => setVerdict(v)}
                    >
                      {VERDICT_LABEL[v]}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          {input && plan ? (
            <div className="wt-derived">
              {!reviewDone ? (
                <div className="wt-derived-row">
                  <span className="wt-derived-key">On lines</span>
                  <span className="wt-derived-val">{lines === 0 ? 'none' : plural(lines, 'comment', 'comments')}</span>
                </div>
              ) : null}
              {outside > 0 ? (
                <div className="wt-derived-row">
                  <span className="wt-derived-key">In summary</span>
                  <span className="wt-derived-val">
                    {outside}, not on lines GitHub takes: {plan.outside.map((d) => `${d.path}:${d.lineStart}`).join(', ')}
                  </span>
                </div>
              ) : null}
              {replies > 0 ? (
                <div className="wt-derived-row">
                  <span className="wt-derived-key">Replies</span>
                  <span className="wt-derived-val">{reviewDone ? replies : `${replies}, right after the review`}</span>
                </div>
              ) : null}
              {!reviewDone ? (
                <div className="wt-derived-row">
                  <span className="wt-derived-key">Commit</span>
                  <span className="wt-derived-val">{input.commitId.slice(0, 7)}, the one you reviewed</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {moved && !reviewDone ? (
            <div className="wt-notice">
              <strong>{movedWords}</strong> since this copy was checked out. Your comments go on{' '}
              {input!.commitId.slice(0, 7)}; GitHub marks any whose lines have changed since as outdated, as it does for anyone.
            </div>
          ) : null}

          {reviewDone ? (
            <div className="wt-notice" data-tone="safe">
              <strong>The review was posted.</strong>
            </div>
          ) : null}

          {outcome ? (
            <div className="wt-error" role="alert">
              <div className="wt-error-head">
                {outcome.reviewSent
                  ? `${plural(replies, 'reply', 'replies')} did not go out`
                  : 'GitHub did not take the review'}
              </div>
              <pre className="wt-error-body">{outcome.message}</pre>
              <div className="wt-error-actions">
                <span className="wt-modal-sub">
                  {outcome.reviewSent
                    ? 'Kept as drafts on their threads: the next click sends only these.'
                    : `Nothing was sent, and your drafts are kept. ${failureAdvice(outcome.kind)}`}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="wt-modal-foot">
          <span className="wt-modal-sub">{why ?? 'Posted as you, through gh.'}</span>
          <span className="wt-foot-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {outcome ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !plan || why !== null || nothing}
            onClick={() => void send()}
          >
            {busy ? 'Sending…' : action}
          </button>
        </div>
      </div>
    </div>
  );
}
