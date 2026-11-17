/**
 * The comment on a marked passage, shown at the passage (#434).
 *
 * A click on a passage with a comment waiting opens this under the line
 * clicked: every comment the passage has (several, or overlapping ones),
 * oldest first, each with Edit and Remove. It is a third view of the To Send
 * list (toSend.ts), with the list's editor and rules: Edit opens
 * `ToSendEditor` (⌘↩ saves, Esc cancels), what is typed is kept in the open
 * edit (view 'passage') so closing the popover loses nothing, Remove takes
 * the comment out of To Send and closes its edits in every view, and while a
 * send carries the list, Edit and Remove wait.
 *
 * Esc closes it and goes no further: not to the editor's window listener,
 * and the popover marks it handled, so it never leaves full screen.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { removeComment } from './drafts';
import { saveQuoteEdit, ToSendEditor } from './ToSendEditor';
import { closeEdit, closeEditsFor, findEdit, openEdit, setEditWords, useOpenEdits, useToSendFrozen } from './toSend';
import type { TranscriptComment } from './transcriptQuotes';

export function PassagePopover({
  taskId,
  comments,
  top,
  left,
  width,
  onClose,
}: {
  taskId: number;
  /** The passage's comments still To Send, oldest first. */
  comments: readonly TranscriptComment[];
  top: number;
  left: number;
  width: number;
  onClose: () => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const frozen = useToSendFrozen(taskId);
  const edits = useOpenEdits(taskId);
  const editing = comments.some((c) => findEdit(edits, 'passage', 'quote', c.id) !== undefined);

  // Opened by a click on text, which leaves focus where it was: take it, so
  // Esc and Tab reach the popover. Again when an edit closes or a comment is
  // removed and the control that had focus goes with it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = document.activeElement;
    if (active === null || active === document.body || !el.contains(active)) {
      if (!editing) el.focus({ preventScroll: true });
    }
  }, [editing, comments.length]);

  // A press anywhere else closes it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="tx-cmt-pop"
      role="dialog"
      aria-label={comments.length === 1 ? 'Your comment' : 'Your comments'}
      tabIndex={-1}
      data-focus-keeps-tab=""
      style={{ top, left, ...(width > 0 ? { width } : {}) }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="tx-cmt-pop-top">
        <span>{comments.length === 1 ? 'Your comment' : `Your ${comments.length} comments`}</span>
        <span className="tx-cmt-pop-chip">To Send · goes with your next message</span>
      </div>
      <ul className="tx-cmt-pop-list">
        {comments.map((c) => (
          <PopoverItem key={c.id} taskId={taskId} comment={c} frozen={frozen} />
        ))}
      </ul>
    </div>
  );
}

function PopoverItem({ taskId, comment, frozen }: { taskId: number; comment: TranscriptComment; frozen: boolean }): ReactNode {
  const which = { taskId, view: 'passage', kind: 'quote', id: comment.id } as const;
  const edit = findEdit(useOpenEdits(taskId), 'passage', 'quote', comment.id);
  return (
    <li className="tx-cmt-pop-item">
      {edit ? (
        <ToSendEditor
          words={edit.words}
          onWords={(w) => setEditWords(which, w)}
          frozen={frozen}
          onSave={(words) => {
            saveQuoteEdit(taskId, comment, words);
            closeEdit(which);
          }}
          onCancel={() => closeEdit(which)}
        />
      ) : (
        <>
          <div className="tx-cmt-pop-text">{comment.comment}</div>
          <div className="tx-cmt-pop-acts">
            <button type="button" className="tx-cmt-pop-act" onClick={() => openEdit({ ...which, initial: comment.comment })} disabled={frozen}>
              Edit
            </button>
            <button
              type="button"
              className="tx-cmt-pop-act"
              onClick={() => {
                closeEditsFor(taskId, 'quote', comment.id);
                removeComment(taskId, comment.id);
              }}
              disabled={frozen}
            >
              Remove
            </button>
          </div>
        </>
      )}
    </li>
  );
}
