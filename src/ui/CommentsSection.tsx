/**
 * The task's review comments, at the top of the Touched Files pane, grouped
 * by their life (#222): Waiting (they go with your next message, from the
 * queue above the message box), Sent, and Resolved folded away with why.
 * Sending is the composer's: there is no Add to Message here any more, and
 * the intro is edited from that queue.
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
  type ReviewComment,
} from '../db/comments';
import { useReadFile } from './editor/openFile';
import { Disclosure } from './Disclosure';

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
  const [notice, setNotice] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const read = useReadFile();

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
  useEffect(() => {
    if (sentPaths === '') {
      setTexts(new Map());
      return;
    }
    let live = true;
    void (async () => {
      const next = new Map<string, string | null>();
      for (const p of sentPaths.split('\n')) next.set(p, await read(p).catch(() => null));
      if (!live) return;
      setTexts(next);
      const resolvable = all.filter((c) => shouldAutoResolve(c, next.get(c.path) ?? null)).map((c) => c.id);
      if (resolvable.length > 0) {
        resolveComments(task.id, resolvable).catch((err: unknown) => console.warn('[comments] could not resolve', err));
      }
    })();
    return () => {
      live = false;
    };
    // `all` is read for the ids only; the paths decide when to look again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, sentPaths, reloadKey, read]);

  const comments = all.filter((c) => c.resolvedAt === null);
  const resolved = all.filter((c) => c.resolvedAt !== null);
  if (all.length === 0) return null;

  const unsent = comments.filter((c) => c.sentAt === null);
  const sent = comments.filter((c) => c.sentAt !== null);

  const row = (c: ReviewComment, end: ReactNode) => (
    <div key={c.id} className="tf-comment">
      <button
        type="button"
        className="tf-comment-open"
        onClick={() => onOpen(c.path, c.lineStart)}
        title={`${commentLocation(c)}\n\n${c.body}`}
      >
        <span className="tf-comment-where">
          <span className="tf-name">{c.path.split('/').pop()}</span>:
          {c.lineStart === c.lineEnd ? c.lineStart : `${c.lineStart}-${c.lineEnd}`}
        </span>
        <span className="tf-comment-body">{c.body.split('\n')[0]}</span>
      </button>
      {end}
    </div>
  );

  return (
    <section className="tf-section tf-comments">
      <div className="tf-section-head tf-comments-head">
        Comments<span className="tf-section-count">{comments.length}</span>
      </div>

      {notice && <div className="tf-comments-notice">{notice}</div>}

      {/* Grouped by state (#222), so ✓ only ever means Resolve. */}
      {unsent.length > 0 && (
        <div className="tf-comments-group" role="group" aria-label={`Waiting, ${unsent.length}`}>
          <div className="tf-comments-sub">Waiting · {unsent.length}</div>
          {unsent.map((c) => row(c, null))}
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
                    <span className="tf-name">{c.path.split('/').pop()}</span>:
                    {c.lineStart === c.lineEnd ? c.lineStart : `${c.lineStart}-${c.lineEnd}`}
                  </span>
                  <span className="tf-comment-body">
                    {c.body.split('\n')[0]}
                    <span className="tf-comment-why">
                      {' '}
                      ·{' '}
                      {resolvedReason(c, texts.get(c.path) ?? null) === 'changed'
                        ? 'its lines changed after it was sent'
                        : 'resolved by you'}
                    </span>
                  </span>
                </button>
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
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
