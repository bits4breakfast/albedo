/**
 * A review comment and the box to write one, as React components, for the
 * editor's Diff mode. The File mode draws the same thing as CodeMirror
 * widgets (comments.ts); both use the classes in comments.css, so the two
 * look the same.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ReviewComment } from '../../db/comments';
import { ACTION_LABEL, cardState, resolvedTrace } from './commentLabels';

function where(from: number, to: number): string {
  return from === to ? `Line ${from}` : `Lines ${from}–${to}`;
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
  // One main action on the row, the rest under ⋯ (#222); the File mode's
  // widget draws the same from the same `cardState`.
  const [more, setMore] = useState(false);
  const card = cardState(comment);
  const run = { edit: onEdit, resolve: onResolve, delete: onDelete };
  const action = (a: 'edit' | 'resolve' | 'delete', primary: boolean) => (
    <button
      key={a}
      type="button"
      className={a === 'delete' ? 'ed-cmt-btn ed-cmt-danger' : primary ? 'ed-cmt-btn ed-cmt-primary' : 'ed-cmt-btn'}
      onClick={run[a]}
    >
      {ACTION_LABEL[a]}
    </button>
  );
  return (
    <div className="ed-cmt" data-state={card.state}>
      <div className="ed-cmt-head">
        <span className="ed-cmt-where">{where(comment.lineStart, comment.lineEnd)}</span>
        <span className="ed-cmt-chip" data-state={card.state}>
          {card.chip}
        </span>
        <span className="ed-cmt-actions">
          {action(card.main, card.state === 'sent')}
          {more ? card.more.map((a) => action(a, false)) : null}
          <button
            type="button"
            className="ed-cmt-btn ed-cmt-more"
            aria-expanded={more}
            aria-label="More actions"
            title="More actions"
            onClick={() => setMore((v) => !v)}
          >
            ⋯
          </button>
        </span>
      </div>
      <div className="ed-cmt-body">{comment.body}</div>
    </div>
  );
}

/**
 * The bar above a file's diff or text for the comments that are not on its
 * lines (#222): one resolved on its own while the file was open (a one-line
 * trace with Reopen), and an unsent one whose lines are gone (outdated, with
 * Resolve and Delete). Never pinned to whatever sits at their old lines.
 * File mode, Diff mode and the guide show the same bar.
 */
export function CommentsBar({
  traces,
  outdated,
  onReopen,
  onResolve,
  onDelete,
}: {
  traces: readonly ReviewComment[];
  outdated: readonly ReviewComment[];
  onReopen: (c: ReviewComment) => void;
  onResolve: (c: ReviewComment) => void;
  onDelete: (c: ReviewComment) => void;
}): ReactNode {
  if (traces.length === 0 && outdated.length === 0) return null;
  return (
    <div className="ed-cmt-bar">
      {traces.map((c) => (
        <div key={`t${c.id}`} className="ed-cmt-trace" title={c.body}>
          <span className="ed-cmt-trace-mark" aria-hidden="true">
            ✓
          </span>
          <span className="ed-cmt-trace-text">
            Resolved: {resolvedTrace(c)} <span className="ed-cmt-trace-body">· “{c.body.split('\n')[0]}”</span>
          </span>
          <button type="button" className="ed-cmt-btn" onClick={() => onReopen(c)}>
            Reopen
          </button>
        </div>
      ))}
      {outdated.length > 0 ? (
        <div className="ed-cmt-outdated">
          <span className="ed-cmt-outdated-lead">
            {outdated.length === 1 ? 'A comment' : `${outdated.length} comments`} on this file no longer match its code:
          </span>
          {outdated.map((c) => (
            <span key={`o${c.id}`} className="ed-cmt-outdated-item" title={c.anchorText}>
              <span className="ed-cmt-outdated-body">
                {where(c.lineStart, c.lineEnd)}: {c.body.split('\n')[0]}
              </span>
              <button type="button" className="ed-cmt-btn" onClick={() => onResolve(c)}>
                ✓ Resolve
              </button>
              <button type="button" className="ed-cmt-btn ed-cmt-danger" onClick={() => onDelete(c)}>
                Delete
              </button>
            </span>
          ))}
        </div>
      ) : null}
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
