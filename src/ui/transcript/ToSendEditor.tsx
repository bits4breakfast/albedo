/**
 * Editing a To Send comment in place (#404): the same field, keys and rules
 * in the list above the message box and in Files ▸ Comments.
 *
 * ⌘↩ saves, Esc cancels (and goes no further: it would close what holds the
 * list). A comment cannot be saved empty -- Remove is for that -- except a
 * suggested edit (#411), whose words are optional: the field edits only the
 * words, and the suggestion stays as it is.
 *
 * While a send carries the comment, Save waits. What is typed is kept in
 * the open edit (toSend.ts `openEdit`), not in this field: when the send
 * delivers the comment and its row goes, the composer settles it -- a code
 * comment, now sent, takes the words as an edit; a quote's words go into
 * the message box.
 */

import type { ReactNode } from 'react';
import { editComment as editCodeComment, type ReviewComment } from '../../db/comments';
import { joinSuggestion, splitSuggestion } from '../../lib/suggestion';
import { editComment as editQuoteComment } from './drafts';
import { closeEditsFor } from './toSend';
import type { TranscriptComment } from './transcriptQuotes';

/** What the field opens with for a code comment: its words, without a suggestion's code. */
export function codeEditText(c: Pick<ReviewComment, 'body'>): string {
  const { suggestion, text } = splitSuggestion(c.body);
  return suggestion === null ? c.body : text;
}

/** Whether a code comment's words may be saved empty: only beside a suggestion. */
export function codeEditMayBeEmpty(c: Pick<ReviewComment, 'body'>): boolean {
  return splitSuggestion(c.body).suggestion !== null;
}

/** Save a code comment's new words, its suggestion kept. */
export function saveCodeEdit(taskId: number, c: Pick<ReviewComment, 'id' | 'body'>, words: string): Promise<void> {
  return editCodeComment(taskId, c.id, joinSuggestion(splitSuggestion(c.body).suggestion, words));
}

/**
 * Save a quote's comment, trimmed; empty is not a comment. Its edits in the
 * other views close too (#434 review): opened on the old words, each would
 * otherwise later settle its own words into the message box.
 */
export function saveQuoteEdit(taskId: number, c: Pick<TranscriptComment, 'id'>, words: string): void {
  editQuoteComment(taskId, c.id, words.trim());
  closeEditsFor(taskId, 'quote', c.id);
}

export function ToSendEditor({
  words: draft,
  onWords,
  mayBeEmpty = false,
  frozen = false,
  onSave,
  onCancel,
}: {
  /** What the field holds: kept outside it (`OpenEdit.words`). */
  words: string;
  onWords: (words: string) => void;
  mayBeEmpty?: boolean;
  /**
   * A send already carries the comment (`useToSendFrozen`): new words would
   * never reach Claude, yet be marked sent with it. The field stays open, so
   * nothing typed is lost; Save waits, and if the send takes the comment the
   * words are settled for it.
   */
  frozen?: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}): ReactNode {
  const empty = draft.trim().length === 0 && !mayBeEmpty;
  const save = () => {
    if (!empty && !frozen) onSave(draft);
  };
  return (
    /* A field and its Save / Cancel: Tab walks between them. */
    <div className="tx-waiting-edit" data-focus-keeps-tab="">
      <textarea
        className="tx-cmt-input"
        aria-label="Edit comment"
        value={draft}
        rows={Math.min(6, Math.max(2, draft.split('\n').length))}
        autoFocus
        onChange={(e) => onWords(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="tx-cmt-foot">
        <button type="button" className="tx-btn tx-queued-act" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="tx-btn tx-queued-act tx-cmt-add" onClick={save} disabled={empty || frozen}>
          Save <span className="tx-cmt-key">⌘↩</span>
        </button>
      </div>
    </div>
  );
}
