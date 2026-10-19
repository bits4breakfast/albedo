/**
 * A review comment and the box to write one, as React components, for the
 * editor's Diff mode. The File mode draws the same thing as CodeMirror
 * widgets (comments.ts); both use the classes in comments.css, so the two
 * look the same.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ReviewComment } from '../../db/comments';

function where(from: number, to: number): string {
  return from === to ? `line ${from}` : `lines ${from}–${to}`;
}

export function CommentCardView({
  comment,
  onEdit,
  onResolve,
  onDelete,
}: {
  comment: ReviewComment;
  onEdit: () => void;
  onResolve: () => void;
  onDelete: () => void;
}): ReactNode {
  return (
    <div className="ed-cmt">
      <div className="ed-cmt-head">
        <span className="ed-cmt-where">{where(comment.lineStart, comment.lineEnd)}</span>
        <span className={comment.sentAt ? 'ed-cmt-state ed-cmt-sent' : 'ed-cmt-state'}>
          {comment.sentAt ? 'sent to Claude' : 'not sent'}
        </span>
        <span className="ed-cmt-actions">
          <button type="button" className="ed-cmt-btn" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="ed-cmt-btn" onClick={onResolve}>
            Resolve
          </button>
          <button type="button" className="ed-cmt-btn ed-cmt-danger" onClick={onDelete}>
            Delete
          </button>
        </span>
      </div>
      <div className="ed-cmt-body">{comment.body}</div>
    </div>
  );
}

export function CommentDraftView({
  from,
  to,
  initial,
  editing,
  onSave,
  onCancel,
}: {
  from: number;
  to: number;
  initial: string;
  editing: boolean;
  /** Resolves once stored; the box stays (with its text) if it rejects. */
  onSave: (text: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const save = () => {
    if (text.trim() !== '') onSave(text.trim());
  };
  return (
    <div className="ed-cmt ed-cmt-draft">
      <textarea
        ref={ref}
        className="ed-cmt-input"
        rows={3}
        value={text}
        placeholder="Leave a comment for Claude — any number of lines. ⌘↵ to save, Esc to cancel."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            // Stop here: Esc also closes the editor tab.
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else {
            // Plain Enter is a new line in the comment and nothing else.
            e.stopPropagation();
          }
        }}
      />
      <div className="ed-cmt-foot">
        <span className="ed-cmt-where">{where(from, to)}</span>
        <button type="button" className="ed-cmt-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ed-cmt-btn ed-cmt-primary" onClick={save}>
          {editing ? 'Save' : 'Comment'}
        </button>
      </div>
    </div>
  );
}
