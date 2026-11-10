/**
 * A review comment and the box to write one, as React components, for the
 * editor's Diff mode. The File mode draws the same thing as CodeMirror
 * widgets (comments.ts); both use the classes in comments.css, so the two
 * look the same.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ReviewComment } from '../../db/comments';
import type { ReviewThread } from '../../gh/reviewThreads';
import { openExternal } from '../../lib/openUrl';
import { ACTION_LABEL, DESTINATIONS, ago, cardState, draftPlaceholder, draftSaveLabel, resolvedTrace } from './commentLabels';

function where(from: number, to: number): string {
  return from === to ? `Line ${from}` : `Lines ${from}–${to}`;
}

export function CommentCardView({
  comment,
  onEdit,
  onResolve,
  onDelete,
  outside = false,
}: {
  comment: ReviewComment;
  onEdit: () => void;
  onResolve: () => void;
  onDelete: () => void;
  /** #287: a draft for GitHub on lines outside the PR's diff. */
  outside?: boolean;
}): ReactNode {
  // One main action on the row, the rest under ⋯ (#222); the File mode's
  // widget draws the same from the same `cardState`.
  const [more, setMore] = useState(false);
  const card = cardState(comment, Date.now(), outside);
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
  aside = null,
}: {
  traces: readonly ReviewComment[];
  outdated: readonly ReviewComment[];
  onReopen: (c: ReviewComment) => void;
  onResolve: (c: ReviewComment) => void;
  onDelete: (c: ReviewComment) => void;
  /** #287: GitHub threads on this file that are not on its lines here. */
  aside?: ReactNode;
}): ReactNode {
  if (traces.length === 0 && outdated.length === 0 && aside === null) return null;
  return (
    <div className="ed-cmt-bar">
      {aside}
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

/**
 * Where the comment goes, on a review task only (#287): Ask Claude or
 * Draft for GitHub. A small segmented switch at the head of the box.
 */
export function DestinationSwitch({
  value,
  onChange,
}: {
  value: 'draft' | null;
  onChange: (github: 'draft' | null) => void;
}): ReactNode {
  return (
    <div className="ed-cmt-head">
      <span className="ed-cmt-where">Goes to</span>
      <span className="seg-sm" role="group" aria-label="Where this comment goes">
        {DESTINATIONS.map((d) => (
          <button
            key={d.label}
            type="button"
            aria-pressed={value === d.github}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(d.github)}
          >
            {d.label}
          </button>
        ))}
      </span>
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
  destination,
}: {
  from: number;
  to: number;
  initial: string;
  editing: boolean;
  /** Resolves once stored; the box stays (with its text) if it rejects. */
  onSave: (text: string, github: 'draft' | null) => void;
  onCancel: () => void;
  /**
   * #287: on a review task, where it goes to start with (the choice shows);
   * undefined on every other task, where a comment is for Claude and no
   * choice is drawn.
   */
  destination?: 'draft' | null;
}): ReactNode {
  const [text, setText] = useState(initial);
  const [github, setGithub] = useState<'draft' | null>(destination ?? null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const save = () => {
    if (text.trim() !== '') onSave(text.trim(), github);
  };
  return (
    <div className="ed-cmt ed-cmt-draft">
      {destination !== undefined ? <DestinationSwitch value={github} onChange={setGithub} /> : null}
      <textarea
        ref={ref}
        className="ed-cmt-input"
        rows={3}
        value={text}
        placeholder={draftPlaceholder(github)}
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
          {draftSaveLabel(github, editing)}
        </button>
      </div>
    </div>
  );
}

/** A plain box for a reply's text: ⌘↵ saves, Esc cancels, Enter is a new line. */
function ReplyBox({ initial, editing, onSave, onCancel }: { initial: string; editing: boolean; onSave: (text: string) => void; onCancel: () => void }): ReactNode {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const save = () => {
    if (text.trim() !== '') onSave(text.trim());
  };
  return (
    <>
      <textarea
        ref={ref}
        className="ed-cmt-input"
        rows={3}
        value={text}
        aria-label="Reply"
        placeholder="A reply on GitHub, sent with Submit Review. ⌘↵ to save, Esc to cancel."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else {
            e.stopPropagation();
          }
        }}
      />
      <div className="ed-cmt-foot">
        <span className="ed-cmt-where">Reply</span>
        <button type="button" className="ed-cmt-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ed-cmt-btn ed-cmt-primary" onClick={save}>
          {editing ? 'Save' : 'Add Reply'}
        </button>
      </div>
    </>
  );
}

/** "2 comments", "1 comment". */
function commentsCount(n: number): string {
  return n === 1 ? '1 comment' : `${n} comments`;
}

/**
 * Another reviewer's thread on GitHub (#287, step 4), read only, under the
 * line it is on: the same card as a comment, its edge grey as a sent one's
 * (it is not yours to send), each comment as author · age and its text.
 * Reply and Open on GitHub, both always shown (#327: Open on GitHub sat
 * under ⋯ while the chip's "On GitHub" read as a second link). A resolved
 * thread is folded to one line until Show. Your reply drafts hang under it, and go
 * with Submit Review.
 */
export function ThreadCardView({
  thread,
  prUrl,
  line,
  replies,
  onReply,
  onEditReply,
  onDeleteReply,
}: {
  thread: ReviewThread;
  prUrl: string;
  /** Where it is in the file here; null in the bar (not on this version's lines). */
  line: number | null;
  replies: readonly ReviewComment[];
  onReply: (text: string) => Promise<unknown>;
  onEditReply: (reply: ReviewComment, text: string) => Promise<unknown>;
  onDeleteReply: (reply: ReviewComment) => void;
}): ReactNode {
  const [open, setOpen] = useState(!thread.isResolved);
  const [writing, setWriting] = useState<ReviewComment | 'new' | null>(null);
  const [moreOf, setMoreOf] = useState<number | null>(null);
  const first = thread.comments[0];
  // The chip says what state the thread is in; where it lives is the link's job.
  const state = thread.isResolved ? '✓ Resolved' : thread.isOutdated ? 'Outdated' : null;
  const link = `${prUrl}#discussion_r${thread.replyTo}`;
  const where = line !== null ? `Line ${line}` : thread.line !== null ? `Line ${thread.line} on GitHub` : thread.originalLine !== null ? `Was line ${thread.originalLine}` : 'On GitHub';
  const save = (p: Promise<unknown>) => p.then(() => setWriting(null), () => {});
  return (
    <div className="ed-cmt" data-state="thread">
      <div className="ed-cmt-head">
        <span className="ed-cmt-where">{where}</span>
        <span className="ed-cmt-chip" data-state="sent">
          {state ? `${state} · ` : ''}
          {commentsCount(thread.comments.length)}
        </span>
        {!open && first ? (
          <span className="ed-cmt-fold" title={first.body}>
            {first.author ?? 'someone'}: “{first.body.split('\n')[0]}”
          </span>
        ) : null}
        <span className="ed-cmt-actions">
          {open ? (
            <button type="button" className="ed-cmt-btn" onClick={() => setWriting('new')} disabled={writing !== null}>
              Reply
            </button>
          ) : (
            <button type="button" className="ed-cmt-btn" onClick={() => setOpen(true)}>
              Show
            </button>
          )}
          {open && thread.isResolved ? (
            <button type="button" className="ed-cmt-btn" onClick={() => setOpen(false)}>
              Fold
            </button>
          ) : null}
          <button type="button" className="ed-cmt-btn" onClick={() => void openExternal(link)} title={link}>
            Open on GitHub
          </button>
        </span>
      </div>
      {open
        ? thread.comments.map((c, i) => (
            <div key={i} className="ed-cmt-thread-item">
              <div className="ed-cmt-by">
                <span className="ed-cmt-author">{c.author ?? 'someone'}</span>
                {c.createdAt > 0 ? ` · ${ago(c.createdAt, Date.now())}` : ''}
              </div>
              <div className="ed-cmt-body">{c.body}</div>
            </div>
          ))
        : null}
      {replies.map((r) =>
        writing !== null && writing !== 'new' && writing.id === r.id ? (
          <div key={r.id} className="ed-cmt-thread-item">
            <ReplyBox initial={r.body} editing onSave={(t) => save(onEditReply(r, t))} onCancel={() => setWriting(null)} />
          </div>
        ) : (
          <div key={r.id} className="ed-cmt-thread-item">
            <div className="ed-cmt-head">
              <span className="ed-cmt-where">Your reply</span>
              <span className="ed-cmt-chip" data-state="waiting">
                {cardState(r).chip}
              </span>
              <span className="ed-cmt-actions">
                <button type="button" className="ed-cmt-btn" onClick={() => setWriting(r)}>
                  {ACTION_LABEL.edit}
                </button>
                {moreOf === r.id ? (
                  <button type="button" className="ed-cmt-btn ed-cmt-danger" onClick={() => onDeleteReply(r)}>
                    {ACTION_LABEL.delete}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ed-cmt-btn ed-cmt-more"
                  aria-expanded={moreOf === r.id}
                  aria-label="More actions"
                  title="More actions"
                  onClick={() => setMoreOf((v) => (v === r.id ? null : r.id))}
                >
                  ⋯
                </button>
              </span>
            </div>
            <div className="ed-cmt-body">{r.body}</div>
          </div>
        ),
      )}
      {writing === 'new' ? (
        <div className="ed-cmt-thread-item">
          <ReplyBox initial="" editing={false} onSave={(t) => save(onReply(t))} onCancel={() => setWriting(null)} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * GitHub threads on a file that are not on its lines here (#287): outdated,
 * on a removed line, or their code is gone. One line in the bar above the
 * file, as a resolved comment's trace is; Show lists them as cards there.
 */
export function ThreadsAside({
  threads,
  render,
}: {
  threads: readonly ReviewThread[];
  render: (t: ReviewThread) => ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const first = threads[0]?.comments[0];
  return (
    <>
      <div className="ed-cmt-trace">
        <span className="ed-cmt-trace-mark" aria-hidden="true">
          ↗
        </span>
        <span className="ed-cmt-trace-text">
          {threads.length === 1 ? '1 thread' : `${threads.length} threads`} on GitHub not on this version’s lines
          {first && !open ? (
            <span className="ed-cmt-trace-body">
              {' '}
              · {first.author ?? 'someone'}: “{first.body.split('\n')[0]}”
            </span>
          ) : null}
        </span>
        <button type="button" className="ed-cmt-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open ? threads.map((t) => render(t)) : null}
    </>
  );
}
