/**
 * Every comment waiting to go with the next message, above the message box
 * -- one queue (#222): comments on code (the editor, the guide, a transcript
 * diff) and comments on transcript passages (#187). "3 Comments" opens to the
 * list: each one's place (a file and line, or the passage's first line), the
 * comment, and Jump / Edit / Remove. Send sends them, with whatever the box
 * holds or nothing; they leave the list once that message is delivered or
 * held (drafts.ts `takeComments`, db/comments.ts `markCommentsSent`).
 *
 * The intro a message with code comments opens with is edited here too: it
 * moved from the Files pane with "Add to Message", which is gone.
 *
 * Frozen like the box while a send is under way: the list can be read and
 * jumped from, not changed.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Disclosure } from './Diff';
import { editComment, removeComment, useComments } from './drafts';
import { foldQuote, inTranscriptOrder, type TranscriptComment } from './transcriptQuotes';
import type { RevealPassage } from './passages';
import {
  DEFAULT_COMMENTS_INTRO,
  deleteComment as deleteCodeComment,
  editComment as editCodeComment,
  type ReviewComment,
} from '../../db/comments';
import { useOpenFile } from '../editor/openFile';
import { useCommentsIntro, writeIntro } from '../commentsIntro';

export function WaitingComments({
  taskId,
  frozen,
  onJump,
  code = [],
}: {
  taskId: number;
  frozen: boolean;
  /** Take the reader to a comment's passage; absent: no Jump. */
  onJump?: RevealPassage;
  /** The task's waiting comments on code, by file then line. */
  code?: readonly ReviewComment[];
}): ReactNode {
  const comments = useComments(taskId);
  const [open, setOpen] = useState(false);
  const [editingIntro, setEditingIntro] = useState(false);
  const n = comments.length + code.length;
  if (n === 0) return null;
  return (
    <div className="tx-waiting" role="group" aria-label="Comments waiting to be sent">
      <div className="tx-waiting-bar">
        <button type="button" className="tx-waiting-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Disclosure open={open} /> {n} Comment{n === 1 ? '' : 's'}
          <span className="tx-waiting-hint">go with your next message</span>
        </button>
        {code.length > 0 ? (
          <button
            type="button"
            className="tx-btn tx-queued-act"
            onClick={() => setEditingIntro((v) => !v)}
            aria-expanded={editingIntro}
            title="The line a message with code comments opens with"
          >
            Intro…
          </button>
        ) : null}
      </div>
      {editingIntro && code.length > 0 ? <IntroEditor taskId={taskId} /> : null}
      {open ? (
        <ul className="tx-waiting-list">
          {/* In the order the message carries them: code first, then passages. */}
          {code.map((c) => (
            <CodeItem key={`code-${c.id}`} taskId={taskId} comment={c} frozen={frozen} />
          ))}
          {inTranscriptOrder(comments).map((c) => (
            <WaitingItem key={c.id} taskId={taskId} comment={c} frozen={frozen} onJump={onJump} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function IntroEditor({ taskId }: { taskId: number }): ReactNode {
  const intro = useCommentsIntro();
  return (
    /* A field and its Reset: Tab walks between them. */
    <div className="tx-waiting-intro" data-focus-keeps-tab="">
      <label className="tx-waiting-intro-label" htmlFor={`tx-intro-${taskId}`}>
        A message with code comments starts with
      </label>
      <textarea
        id={`tx-intro-${taskId}`}
        className="tx-cmt-input"
        rows={2}
        value={intro}
        onChange={(e) => writeIntro(e.target.value)}
      />
      <div className="tx-cmt-foot">
        <button
          type="button"
          className="tx-btn tx-queued-act"
          onClick={() => writeIntro(DEFAULT_COMMENTS_INTRO)}
          disabled={intro === DEFAULT_COMMENTS_INTRO}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

/** A comment on code, waiting: its file and lines, the comment, Jump / Edit / Remove. */
function CodeItem({ taskId, comment, frozen }: { taskId: number; comment: ReviewComment; frozen: boolean }): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openFile = useOpenFile();
  const name = comment.path.split('/').pop() ?? comment.path;
  const lines = comment.lineStart === comment.lineEnd ? `${comment.lineStart}` : `${comment.lineStart}–${comment.lineEnd}`;
  const save = () => {
    if (draft === null || draft.trim().length === 0) return;
    editCodeComment(taskId, comment.id, draft.trim()).then(
      () => setDraft(null),
      (err: unknown) => setError(`Could not save it: ${String(err)}`),
    );
  };
  return (
    <li className="tx-waiting-item">
      <div className="tx-waiting-where" title={`${comment.path}:${lines}\n\n${comment.anchorText}`}>
        <span className="tx-waiting-file">{name}</span>:{lines}
      </div>
      {draft !== null ? (
        <div className="tx-waiting-edit" data-focus-keeps-tab="">
          <textarea
            className="tx-cmt-input"
            aria-label="Edit comment"
            value={draft}
            rows={Math.min(6, Math.max(2, draft.split('\n').length))}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setDraft(null);
              }
            }}
          />
          <div className="tx-cmt-foot">
            <button type="button" className="tx-btn tx-queued-act" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="button" className="tx-btn tx-queued-act tx-cmt-add" onClick={save} disabled={draft.trim().length === 0}>
              Save <span className="tx-cmt-key">⌘↩</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="tx-waiting-row">
          <div className="tx-waiting-comment">{comment.body}</div>
          <button
            type="button"
            className="tx-btn tx-queued-act"
            title="Open the file at these lines"
            onClick={() => openFile({ path: comment.path, line: comment.lineStart })}
          >
            Jump
          </button>
          <button type="button" className="tx-btn tx-queued-act" onClick={() => setDraft(comment.body)} disabled={frozen}>
            Edit
          </button>
          <button
            type="button"
            className="tx-btn tx-queued-act"
            onClick={() => deleteCodeComment(taskId, comment.id).catch((err: unknown) => setError(`Could not remove it: ${String(err)}`))}
            disabled={frozen}
          >
            Remove
          </button>
        </div>
      )}
      {error ? <div className="tx-waiting-error">{error}</div> : null}
    </li>
  );
}

function WaitingItem({
  taskId,
  comment,
  frozen,
  onJump,
}: {
  taskId: number;
  comment: TranscriptComment;
  frozen: boolean;
  onJump?: RevealPassage;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const { first, more } = foldQuote(comment.quote);
  const save = () => {
    if (draft === null || draft.trim().length === 0) return;
    editComment(taskId, comment.id, draft.trim());
    setDraft(null);
  };
  return (
    <li className="tx-waiting-item">
      <div className="tx-waiting-quote" title={comment.quote}>
        {first}
        {more > 0 ? <span className="tx-waiting-more"> +{more} line{more === 1 ? '' : 's'}</span> : null}
      </div>
      {draft !== null ? (
        /* A field and its Save / Cancel: Tab walks between them. */
        <div className="tx-waiting-edit" data-focus-keeps-tab="">
          <textarea
            className="tx-cmt-input"
            aria-label="Edit comment"
            value={draft}
            rows={Math.min(6, Math.max(2, draft.split('\n').length))}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setDraft(null);
              }
            }}
          />
          <div className="tx-cmt-foot">
            <button type="button" className="tx-btn tx-queued-act" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="button" className="tx-btn tx-queued-act tx-cmt-add" onClick={save} disabled={draft.trim().length === 0}>
              Save <span className="tx-cmt-key">⌘↩</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="tx-waiting-row">
          <div className="tx-waiting-comment">{comment.comment}</div>
          {onJump ? (
            <button
              type="button"
              className="tx-btn tx-queued-act"
              title="Show the passage in the transcript"
              onClick={() => onJump({ messageId: comment.messageId, quote: comment.quote, offset: comment.offset })}
            >
              Jump
            </button>
          ) : null}
          <button type="button" className="tx-btn tx-queued-act" onClick={() => setDraft(comment.comment)} disabled={frozen}>
            Edit
          </button>
          <button type="button" className="tx-btn tx-queued-act" onClick={() => removeComment(taskId, comment.id)} disabled={frozen}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}
