/**
 * The task's open review comments, at the top of the Touched Files pane, and
 * the way to hand them to Claude Code: "Add to message" puts every unsent
 * comment into the composer under an intro the person can rewrite. Sending is
 * the composer's job; a comment counts as sent once a message carrying it
 * has actually gone out.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '../types';
import {
  commentLocation,
  DEFAULT_COMMENTS_INTRO,
  formatForClaude,
  listComments,
  markCommentsSent,
  onCommentsChanged,
  resolveComment,
  type ReviewComment,
} from '../db/comments';
import { insertIntoComposer } from './transcript/composerBridge';

const INTRO_KEY = 'albedo.comments.intro';

function readIntro(): string {
  try {
    return window.localStorage.getItem(INTRO_KEY) ?? DEFAULT_COMMENTS_INTRO;
  } catch {
    return DEFAULT_COMMENTS_INTRO;
  }
}

function writeIntro(text: string): void {
  try {
    if (text === DEFAULT_COMMENTS_INTRO) window.localStorage.removeItem(INTRO_KEY);
    else window.localStorage.setItem(INTRO_KEY, text);
  } catch {
    /* kept for this session only */
  }
}

export interface CommentsSectionProps {
  task: Task;
  onOpen: (path: string, line: number) => void;
}

export default function CommentsSection({ task, onOpen }: CommentsSectionProps): ReactNode {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [editingIntro, setEditingIntro] = useState(false);
  const [intro, setIntro] = useState(readIntro);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      void listComments(task.id).then(
        (rows) => {
          if (live) setComments(rows);
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

  if (comments.length === 0) return null;

  const unsent = comments.filter((c) => c.sentAt === null);

  const addToMessage = () => {
    const batch = unsent;
    const taken = insertIntoComposer({
      taskId: task.id,
      text: formatForClaude(batch, intro),
      // Sent means Claude Code received a message naming it -- not merely
      // that it was put in the composer, where it may be edited or dropped.
      onSent: (sent) => {
        const delivered = batch.filter((c) => sent.includes(commentLocation(c)));
        if (delivered.length > 0) {
          markCommentsSent(task.id, delivered.map((c) => c.id)).catch((err: unknown) =>
            setNotice(`The message went out, but the comments could not be marked as sent: ${String(err)}`),
          );
        }
        return delivered.length > 0;
      },
    });
    setNotice(taken ? null : 'Open the task’s transcript to get its message box, then try again.');
  };

  return (
    <section className="tf-section tf-comments">
      <div className="tf-section-head tf-comments-head">
        Comments<span className="tf-section-count">{comments.length}</span>
        <span className="tf-comments-actions">
          <button type="button" className="tf-btn" onClick={() => setEditingIntro((v) => !v)} aria-expanded={editingIntro}>
            Intro…
          </button>
          <button
            type="button"
            className="tf-btn tf-btn-primary"
            onClick={addToMessage}
            disabled={unsent.length === 0}
            title={unsent.length === 0 ? 'Every open comment has been sent' : 'Put the unsent comments in the message box, to read and send'}
          >
            Add {unsent.length > 0 ? unsent.length : ''} to message
          </button>
        </span>
      </div>

      {editingIntro && (
        <div className="tf-comments-intro">
          <label className="tf-comments-intro-label" htmlFor={`tf-intro-${task.id}`}>
            The message starts with
          </label>
          <textarea
            id={`tf-intro-${task.id}`}
            className="tf-comments-intro-input"
            rows={3}
            value={intro}
            onChange={(e) => {
              setIntro(e.target.value);
              writeIntro(e.target.value);
            }}
          />
          <button
            type="button"
            className="tf-btn"
            onClick={() => {
              setIntro(DEFAULT_COMMENTS_INTRO);
              writeIntro(DEFAULT_COMMENTS_INTRO);
            }}
            disabled={intro === DEFAULT_COMMENTS_INTRO}
          >
            Reset
          </button>
        </div>
      )}

      {notice && <div className="tf-comments-notice">{notice}</div>}

      {comments.map((c) => (
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
            {c.sentAt !== null && <span className="tf-comment-sent">sent</span>}
          </button>
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
          </button>
        </div>
      ))}
    </section>
  );
}
