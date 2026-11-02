/**
 * The comments on transcript passages waiting to go with the next message
 * (#187), above the message box: "3 Comments", which opens to the list --
 * each passage's first line, the comment, and Jump / Edit / Remove. Send
 * sends them, with whatever the box holds or nothing; they leave the list
 * once that message is delivered or held (drafts.ts, `takeComments`).
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

export function WaitingComments({
  taskId,
  frozen,
  onJump,
}: {
  taskId: number;
  frozen: boolean;
  /** Take the reader to a comment's passage; absent: no Jump. */
  onJump?: RevealPassage;
}): ReactNode {
  const comments = useComments(taskId);
  const [open, setOpen] = useState(false);
  if (comments.length === 0) return null;
  const n = comments.length;
  return (
    <div className="tx-waiting" role="group" aria-label="Comments waiting to be sent">
      <button type="button" className="tx-waiting-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Disclosure open={open} /> {n} Comment{n === 1 ? '' : 's'}
        <span className="tx-waiting-hint">go with your next message</span>
      </button>
      {open ? (
        <ul className="tx-waiting-list">
          {inTranscriptOrder(comments).map((c) => (
            <WaitingItem key={c.id} taskId={taskId} comment={c} frozen={frozen} onJump={onJump} />
          ))}
        </ul>
      ) : null}
    </div>
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
