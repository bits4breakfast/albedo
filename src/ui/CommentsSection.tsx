/**
 * The task's review comments, at the top of the Touched Files pane, grouped
 * by their life (#222): Waiting (they go with your next message, from the
 * queue above the message box), Sent, and Resolved folded away with why.
 * Sending is the composer's: there is no Add to Message here any more, and
 * the intro is edited from that queue.
 *
 * A PR's failing checks queued for Claude (#280, transcript/ciFailure.ts)
 * wait here too, first in Waiting, with ✕ to drop them.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '../types';
import {
  commentLocation,
  listComments,
  onCommentsChanged,
  reopenComment,
  resolveComment,
  resolveComments,
  resolvedReason,
  shouldAutoResolve,
  sideOf,
  type ReviewComment,
} from '../db/comments';
import { useReadFile } from './editor/openFile';
import { baseTextOf } from './editor/removedBase';
import { Disclosure } from './Disclosure';
import { sendWaitingComments } from './transcript/composerBridge';
import { ciFailureLabel, removeQueuedCi, shortSha, useQueuedCi } from './transcript/ciFailure';
import { useGithubDrafts } from './reviewDrafts';
import { requestSubmitReview } from './SubmitReview';

export interface CommentsSectionProps {
  task: Task;
  onOpen: (path: string, line: number) => void;
  /**
   * Bumped by the Files pane when the transcript advances, the window comes
   * back or a file is saved: when a sent comment's lines may have changed,
   * so it is looked at again (#222).
   */
  reloadKey?: number;
}

export default function CommentsSection({ task, onOpen, reloadKey = 0 }: CommentsSectionProps): ReactNode {
  /** Every comment, resolved ones too: they fold away below the open ones. */
  const [all, setAll] = useState<ReviewComment[]>([]);
  /** The commented files as they are now, for why a comment was resolved. */
  const [texts, setTexts] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  /** For comments on removed lines (#402): their files at the base, which say whether the lines are back. */
  const [bases, setBases] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const read = useReadFile();
  const ci = useQueuedCi(task.id);
  // A review task's drafts for GitHub (#287), replies included: their own
  // group, never Waiting, whose Send goes to Claude.
  const drafts = useGithubDrafts(task);

  useEffect(() => {
    let live = true;
    const load = () =>
      void listComments(task.id, { includeResolved: true }).then(
        (rows) => {
          if (live) setAll(rows);
        },
        (err: unknown) => console.warn('[comments] could not load', err),
      );
    load();
    const off = onCommentsChanged((id) => {
      if (id === task.id) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [task.id]);

  // A sent comment whose lines are gone resolves itself (#222): looked at on
  // opening and on each reload, never from the terminal. Reading the files
  // also gives the reason a resolved comment shows. The resolve's change
  // event reloads the list, which looks once more and finds nothing to do.
  const sentPaths = all
    .filter((c) => c.sentAt !== null)
    .map((c) => c.path)
    .sort()
    .filter((p, i, a) => a.indexOf(p) === i)
    .join('\n');
  // Of those, the files with a sent comment on removed lines (#402): only
  // they are read at the base too.
  const removedPaths = all
    .filter((c) => c.sentAt !== null && sideOf(c) === 'old')
    .map((c) => c.path)
    .sort()
    .filter((p, i, a) => a.indexOf(p) === i)
    .join('\n');
  useEffect(() => {
    if (sentPaths === '') {
      setTexts(new Map());
      setBases(new Map());
      return;
    }
    let live = true;
    void (async () => {
      const next = new Map<string, string | null>();
      for (const p of sentPaths.split('\n')) next.set(p, await read(p).catch(() => null));
      const atBase = new Map<string, string | null>();
      if (removedPaths !== '') for (const p of removedPaths.split('\n')) atBase.set(p, await baseTextOf(task, p));
      if (!live) return;
      setTexts(next);
      setBases(atBase);
      const resolvable = all
        .filter((c) => shouldAutoResolve(c, next.get(c.path) ?? null, atBase.get(c.path) ?? null))
        .map((c) => c.id);
      if (resolvable.length > 0) {
        resolveComments(task.id, resolvable).catch((err: unknown) => console.warn('[comments] could not resolve', err));
      }
    })();
    return () => {
      live = false;
    };
    // `all` is read for the ids only; the paths decide when to look again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, sentPaths, removedPaths, reloadKey, read]);

  const comments = all.filter((c) => c.resolvedAt === null);
  const resolved = all.filter((c) => c.resolvedAt !== null);
  if (all.length === 0 && ci === null && drafts.length === 0) return null;

  const unsent = comments.filter((c) => c.sentAt === null && c.github === null);
  const waiting = unsent.length + (ci ? 1 : 0);
  const sha = ci ? shortSha(ci.sha) : null;
  const sent = comments.filter((c) => c.sentAt !== null);

  const row = (c: ReviewComment, end: ReactNode) => (
    <div key={c.id} className="tf-comment">
      <button
        type="button"
        className="tf-comment-open"
        onClick={() => onOpen(c.path, c.lineStart)}
        title={`${commentLocation(c)}\n\n${c.body}`}
      >
        {/* The name gives way, never the line (#258): a long one ellipsizes
            inside its row instead of running under the ✓. */}
        <span className="tf-comment-where">
          <span className="tf-name">{c.path.split('/').pop()}</span>
          <span className="tf-comment-line">{lineLabel(c)}</span>
        </span>
        <span className="tf-comment-body">{c.body.split('\n')[0]}</span>
      </button>
      {end}
    </div>
  );

  return (
    <section className="tf-section tf-comments">
      <div className="tf-section-head tf-comments-head">
        Comments<span className="tf-section-count">{comments.length + drafts.filter((d) => d.replyTo !== null).length + (ci ? 1 : 0)}</span>
      </div>

      {notice && <div className="tf-comments-notice">{notice}</div>}

      {/* Grouped by state (#222), so ✓ only ever means Resolve. */}
      {waiting > 0 && (
        <div className="tf-comments-group" role="group" aria-label={`Waiting, ${waiting}`}>
          <div className="tf-comments-sub">
            Waiting · {waiting}
            {/* Send them now (#258), as ⇧⌘S does: the transcript then shows. */}
            <button
              type="button"
              className="tf-btn tf-comments-send"
              onClick={() => sendWaitingComments(task.id)}
              aria-keyshortcuts="Meta+Shift+S"
              title="Send what is waiting to Claude now, and show the transcript (⇧⌘S). What you're typing in the message box stays there."
            >
              Send
            </button>
          </div>
          {/* First, as the message carries it. Not a link: the checks' links are in the message box's list. */}
          {ci && (
            <div className="tf-comment tf-comment-ci">
              <div
                className="tf-comment-open tf-comment-static"
                title={[`CI failed on PR #${ci.prNumber}${sha ? ` (${sha})` : ''}`, ...ci.checks.map((c) => `${c.name}: ${c.conclusion}`)].join('\n')}
              >
                <span className="tf-comment-ci-label">{ciFailureLabel(ci)}</span>
                <span className="tf-comment-body">{ci.checks.map((c) => c.name).join(', ')}</span>
              </div>
              <button
                type="button"
                className="tf-comment-resolve tf-comment-drop"
                onClick={() => removeQueuedCi(task.id, ci.sha)}
                title="Don’t send this failure to Claude"
                aria-label="Remove the CI failure"
              >
                ✕
              </button>
            </div>
          )}
          {unsent.map((c) => row(c, null))}
        </div>
      )}
      {drafts.length > 0 && (
        <div className="tf-comments-group" role="group" aria-label={`For GitHub, ${drafts.length}`}>
          <div className="tf-comments-sub">
            For GitHub · {drafts.length}
            {/* The same dialog as the task bar's Submit Review, as Send above
                is ⇧⌘S's: where the drafts are listed, they can go. */}
            <button
              type="button"
              className="tf-btn tf-comments-send"
              onClick={() => requestSubmitReview(task.id)}
              title="Send these to the pull request as one review, with a summary and a verdict"
            >
              Submit…
            </button>
          </div>
          {drafts.map((c) =>
            c.replyTo === null ? (
              row(c, null)
            ) : (
              <div key={c.id} className="tf-comment">
                <button
                  type="button"
                  className="tf-comment-open"
                  onClick={() => onOpen(c.path, c.lineStart)}
                  title={`Reply on ${commentLocation(c)}\n\n${c.body}`}
                >
                  <span className="tf-comment-where">
                    <span className="tf-name">{c.path.split('/').pop()}</span>
                    <span className="tf-comment-line">:{c.lineStart}</span>
                  </span>
                  <span className="tf-comment-body">Reply: {c.body.split('\n')[0]}</span>
                </button>
              </div>
            ),
          )}
        </div>
      )}
      {sent.length > 0 && (
        <div className="tf-comments-group" role="group" aria-label={`Sent, ${sent.length}`}>
          <div className="tf-comments-sub">↗ Sent · {sent.length}</div>
          {sent.map((c) =>
            row(
              c,
              <button
                type="button"
                className="tf-comment-resolve"
                onClick={() =>
                  resolveComment(task.id, c.id).catch((err: unknown) => setNotice(`Could not resolve the comment: ${String(err)}`))
                }
                title="Resolve"
                aria-label={`Resolve the comment on ${commentLocation(c)}`}
              >
                ✓
              </button>,
            ),
          )}
        </div>
      )}
      {resolved.length > 0 && (
        <div className="tf-comments-group" role="group" aria-label={`Resolved, ${resolved.length}`}>
          <button
            type="button"
            className="tf-comments-sub tf-comments-fold"
            onClick={() => setShowResolved((v) => !v)}
            aria-expanded={showResolved}
          >
            <Disclosure open={showResolved} /> Resolved · {resolved.length}
          </button>
          {showResolved &&
            resolved.map((c) => (
              <div key={c.id} className="tf-comment tf-comment-resolved">
                <button
                  type="button"
                  className="tf-comment-open"
                  onClick={() => onOpen(c.path, c.lineStart)}
                  title={`${commentLocation(c)}\n\n${c.body}`}
                >
                  <span className="tf-comment-where">
                    <span className="tf-name">{c.path.split('/').pop()}</span>
                    {lineLabel(c)}
                  </span>
                  <span className="tf-comment-body">
                    {c.body.split('\n')[0]}
                    <span className="tf-comment-why">
                      {' '}
                      ·{' '}
                      {c.github === 'draft' && c.sentAt !== null
                        ? 'posted to GitHub'
                        : reasonText(resolvedReason(c, texts.get(c.path) ?? null, bases.get(c.path) ?? null))}
                    </span>
                  </span>
                </button>
                {/* Posted to GitHub (#287): it is there now, not here to reopen. */}
                {c.github === 'draft' && c.sentAt !== null ? null : (
                <button
                  type="button"
                  className="tf-btn tf-comment-reopen"
                  onClick={() =>
                    reopenComment(task.id, c.id).catch((err: unknown) => setNotice(`Could not reopen the comment: ${String(err)}`))
                  }
                  aria-label={`Reopen the comment on ${commentLocation(c)}`}
                >
                  Reopen
                </button>
                )}
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

/** ":12", ":12-14", or on removed lines (#402) " removed 12-14": where a comment is, after its file's name. */
function lineLabel(c: Pick<ReviewComment, 'lineStart' | 'lineEnd' | 'side'>): string {
  const lines = c.lineStart === c.lineEnd ? `${c.lineStart}` : `${c.lineStart}-${c.lineEnd}`;
  return sideOf(c) === 'old' ? ` removed ${lines}` : `:${lines}`;
}

/** Why a resolved comment is, in the list's words. */
function reasonText(why: ReturnType<typeof resolvedReason>): string {
  if (why === 'changed') return 'its lines changed after it was sent';
  if (why === 'back') return 'its lines are back in the file';
  return 'resolved by you';
}
