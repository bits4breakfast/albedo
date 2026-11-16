/**
 * The task's review comments, at the top of the Touched Files pane, grouped
 * by their life (#222, #409): To Send, Sent, Resolved folded away with why,
 * then a review task's GitHub Drafts and, folded, what was Posted.
 *
 * To Send is the list above the message box, item for item and in its order
 * (#404, `useToSend`): a PR's failing checks (#280), the comments on code,
 * and the comments on transcript passages, each with Edit and Remove (the CI
 * failure with Remove), frozen while a send carries them. Sending is the
 * composer's: Send N asks it, as ⇧⌘S does, and the intro is edited there.
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
import { baseTextOf, useRemovedBase } from './editor/removedBase';
import { Disclosure } from './Disclosure';
import { commentHeadline, commentWords } from '../lib/suggestion';
import { jumpToPassage, sendWaitingComments } from './transcript/composerBridge';
import { ciFailureLabel, removeQueuedCi, shortSha, type QueuedCiFailure } from './transcript/ciFailure';
import {
  closeEdit,
  closeEditsFor,
  findEdit,
  ON_ITS_WAY,
  openEdit,
  sendLabel,
  setEditWords,
  useOpenEdits,
  useToSend,
  useToSendFrozen,
} from './transcript/toSend';
import { useCarriedCodeIds } from './transcript/codeComments';
import { deleteComment as deleteCodeComment } from '../db/comments';
import { removeComment as removeQuote } from './transcript/drafts';
import { foldQuote, type TranscriptComment } from './transcript/transcriptQuotes';
import { codeEditMayBeEmpty, codeEditText, saveCodeEdit, saveQuoteEdit, ToSendEditor } from './transcript/ToSendEditor';
import { useDraftRemovals, useGithubDrafts } from './reviewDrafts';
import { undoDraftRemoval, type DraftRemoval } from '../capture/draftRemovals';
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
  const [showPosted, setShowPosted] = useState(false);
  /** To Send items open for editing here (#404): kept beside the list, so a send that takes one keeps what was typed. */
  const edits = useOpenEdits(task.id);
  const read = useReadFile();
  const toSend = useToSend(task.id);
  const frozen = useToSendFrozen(task.id);
  /** Code comments a held message carries (#409): on their way, listed as Held. */
  const carried = useCarriedCodeIds(task.id);
  const ci = toSend.ci;
  // A review task's drafts for GitHub (#287), replies included: their own
  // group, never To Send, whose Send goes to Claude.
  const drafts = useGithubDrafts(task);
  // Drafts the session removed (#427): a line each in GitHub Draft, with
  // Undo. Never To Send's: they were for GitHub, and are not sent anywhere.
  const removals = useDraftRemovals(task);

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
  // they are read at the base too -- an open one, which may resolve, and a
  // resolved one only while the Resolved group is open to say why.
  const removedPaths = all
    .filter((c) => c.sentAt !== null && sideOf(c) === 'old' && (c.resolvedAt === null || showResolved))
    .map((c) => c.path)
    .sort()
    .filter((p, i, a) => a.indexOf(p) === i)
    .join('\n');
  // The task's measured base, asked for only when such a comment exists.
  const removedBase = useRemovedBase(task, removedPaths !== '');
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
      // One base for the pass, every file read at it.
      const base = removedBase.base;
      if (removedPaths !== '') for (const p of removedPaths.split('\n')) atBase.set(p, await baseTextOf(task.worktreePath, base, p));
      if (!live) return;
      setTexts(next);
      setBases(atBase);
      // A removed comment resolves only from a base that is final (#402).
      const resolvable = all
        .filter((c) => shouldAutoResolve(c, next.get(c.path) ?? null, removedBase.settled ? (atBase.get(c.path) ?? null) : null))
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
  }, [task.id, sentPaths, removedPaths, removedBase.base, removedBase.settled, reloadKey, read]);

  const comments = all.filter((c) => c.resolvedAt === null);
  // Posted to GitHub (#287): resolved by posting, their own folded group (#409).
  const isPosted = (c: ReviewComment) => c.github === 'draft' && c.sentAt !== null;
  const resolved = all.filter((c) => c.resolvedAt !== null && !isPosted(c));
  const posted = all.filter((c) => c.resolvedAt !== null && isPosted(c));
  if (all.length === 0 && toSend.count === 0 && drafts.length === 0 && removals.length === 0) return null;
  const jump = (q: TranscriptComment) => {
    // No transcript of this task to take it (#404): say where it can be done.
    if (!jumpToPassage(task.id, { messageId: q.messageId, quote: q.quote, offset: q.offset })) {
      setNotice('Open the task’s transcript to jump to the passage.');
    }
  };

  const sent = comments.filter((c) => c.sentAt !== null);
  // Already in a held message's body: nothing to edit or remove here, it goes with that message.
  const held = comments.filter((c) => c.sentAt === null && c.github === null && carried.has(c.id));

  const place = (c: ReviewComment) => (
    /* The name gives way, never the line (#258): a long one ellipsizes
       inside its row instead of running under the ✓. */
    <span className="tf-comment-where">
      <span className="tf-name">{c.path.split('/').pop()}</span>
      <span className="tf-comment-line">{lineLabel(c)}</span>
    </span>
  );

  const row = (c: ReviewComment, end: ReactNode) => (
    <div key={c.id} className="tf-comment">
      <button
        type="button"
        className="tf-comment-open"
        onClick={() => onOpen(c.path, c.lineStart)}
        title={`${commentLocation(c)}\n\n${commentWords(c.body)}`}
      >
        {place(c)}
        <span className="tf-comment-body">{commentHeadline(c.body)}</span>
      </button>
      {end}
    </div>
  );

  /** Edit and Remove, as the list above the message box has them; frozen while a send carries them. */
  const acts = (what: string, onEdit: (() => void) | null, onRemove: () => void) => (
    <span className="tf-comment-acts">
      {onEdit ? (
        <button type="button" className="tf-comment-act" onClick={onEdit} disabled={frozen} aria-label={`Edit ${what}`}>
          Edit
        </button>
      ) : null}
      <button
        type="button"
        className="tf-comment-act"
        onClick={onRemove}
        disabled={frozen}
        aria-label={`Remove ${what}`}
        title="Don’t send this to Claude"
      >
        Remove
      </button>
    </span>
  );

  const fail = (what: string) => (err: unknown) => setNotice(`Could not ${what}: ${String(err)}`);

  const codeItem = (c: ReviewComment) => {
    const which = { taskId: task.id, view: 'files', kind: 'code', id: c.id } as const;
    const edit = findEdit(edits, 'files', 'code', c.id);
    return edit ? (
      <div key={c.id} className="tf-comment-edit">
        {place(c)}
        <ToSendEditor
          words={edit.words}
          onWords={(w) => setEditWords(which, w)}
          mayBeEmpty={codeEditMayBeEmpty(c)}
          frozen={frozen}
          onSave={(words) => void saveCodeEdit(task.id, c, words).then(() => closeEdit(which), fail('save the comment'))}
          onCancel={() => closeEdit(which)}
        />
      </div>
    ) : (
      row(
        c,
        acts(
          `the comment on ${commentLocation(c)}`,
          () => openEdit({ ...which, initial: codeEditText(c) }),
          () => void deleteCodeComment(task.id, c.id).catch(fail('remove the comment')),
        ),
      )
    );
  };

  const quoteItem = (q: TranscriptComment) => {
    const { first } = foldQuote(q.quote);
    const where = (
      <span className="tf-comment-where tf-comment-quote" title={q.quote}>
        Transcript quote
      </span>
    );
    const which = { taskId: task.id, view: 'files', kind: 'quote', id: q.id } as const;
    const edit = findEdit(edits, 'files', 'quote', q.id);
    return edit ? (
      <div key={q.id} className="tf-comment-edit">
        {where}
        <ToSendEditor
          words={edit.words}
          onWords={(w) => setEditWords(which, w)}
          frozen={frozen}
          onSave={(words) => {
            saveQuoteEdit(task.id, q, words);
            closeEdit(which);
          }}
          onCancel={() => closeEdit(which)}
        />
      </div>
    ) : (
      <div key={q.id} className="tf-comment">
        {/* Jump: the transcript, at the passage, as the list above the box does. */}
        <button
          type="button"
          className="tf-comment-open"
          onClick={() => jump(q)}
          title={`Show the passage in the transcript\n\n> ${first}\n\n${q.comment}`}
        >
          {where}
          <span className="tf-comment-body">{q.comment}</span>
        </button>
        {acts(
          `the comment on “${first}”`,
          () => openEdit({ ...which, initial: q.comment }),
          () => {
            closeEditsFor(task.id, 'quote', q.id);
            removeQuote(task.id, q.id);
          },
        )}
      </div>
    );
  };

  return (
    <section className="tf-section tf-comments">
      <div className="tf-section-head tf-comments-head">
        Comments<span className="tf-section-count">{held.length + toSend.count + sent.length + drafts.length}</span>
      </div>

      {notice && <div className="tf-comments-notice">{notice}</div>}

      {/* Grouped by state (#222), so ✓ only ever means Resolve. Held first:
          it goes first, as in the band above the message box (#409). */}
      {held.length > 0 && (
        <div className="tf-comments-group" role="group" aria-label={`Held, ${held.length}`}>
          <div className="tf-comments-sub" title="In a held message: they go when it goes, and are changed with it in the message box">
            Held · {held.length}
          </div>
          {held.map((c) => row(c, null))}
        </div>
      )}
      {toSend.count > 0 && (
        <div className="tf-comments-group" role="group" aria-label={`To Send, ${toSend.count}`}>
          <div className="tf-comments-sub">
            To Send · {toSend.count}
            {/* Send them now (#258), as ⇧⌘S does: the transcript then shows. */}
            <button
              type="button"
              className="tf-btn tf-comments-send"
              onClick={() => sendWaitingComments(task.id)}
              // A send already carries them (#404): a second would carry them again.
              disabled={frozen}
              aria-keyshortcuts="Meta+Shift+S"
              title={
                frozen
                  ? ON_ITS_WAY
                  : "Send these to Claude now, and show the transcript (⇧⌘S). What you're typing in the message box stays there."
              }
            >
              {sendLabel(toSend.count)}{' '}
              <span className="tf-comments-send-key" aria-hidden="true">
                ⇧⌘S
              </span>
            </button>
          </div>
          {/* In the order the message carries them: CI, code, then quotes. */}
          {ci && <CiRow ci={ci} remove={acts('the CI failure', null, () => removeQueuedCi(task.id, ci.sha))} />}
          {toSend.code.map(codeItem)}
          {toSend.quotes.map(quoteItem)}
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
                  title={`${commentLocation(c)}\n\n${commentWords(c.body)}`}
                >
                  <span className="tf-comment-where">
                    <span className="tf-name">{c.path.split('/').pop()}</span>
                    {lineLabel(c)}
                  </span>
                  <span className="tf-comment-body">
                    {commentHeadline(c.body)}
                    <span className="tf-comment-why">
                      {' '}
                      · {reasonText(resolvedReason(c, texts.get(c.path) ?? null, bases.get(c.path) ?? null))}
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
      {(drafts.length > 0 || removals.length > 0) && (
        <div className="tf-comments-group" role="group" aria-label={`GitHub Draft, ${drafts.length}`}>
          <div className="tf-comments-sub">
            GitHub Draft · {drafts.length}
            {/* The same dialog as the task bar's Submit Review, as Send above
                is ⇧⌘S's: where the drafts are listed, they can go. */}
            <button
              type="button"
              className="tf-btn tf-comments-send"
              onClick={() => requestSubmitReview(task.id)}
              title="Send these to the pull request as one review, with a summary and a verdict"
            >
              Submit Review…
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
          {removals.map((r) => (
            <RemovedDraftRow
              key={`removed-${r.row.id}`}
              removal={r}
              onUndo={() => void undoDraftRemoval(task.id, r.row.id).catch(fail('put the draft back'))}
            />
          ))}
        </div>
      )}
      {/* On GitHub now (#287): there to read, not here to reopen. */}
      {posted.length > 0 && (
        <div className="tf-comments-group" role="group" aria-label={`Posted, ${posted.length}`}>
          <button
            type="button"
            className="tf-comments-sub tf-comments-fold"
            onClick={() => setShowPosted((v) => !v)}
            aria-expanded={showPosted}
          >
            <Disclosure open={showPosted} /> Posted · {posted.length}
          </button>
          {showPosted && posted.map((c) => row(c, null))}
        </div>
      )}
    </section>
  );
}

/**
 * The queued CI failure, first in To Send as the message carries it. Not a
 * link: the checks' links are in the list above the message box.
 */
function CiRow({ ci, remove }: { ci: QueuedCiFailure; remove: ReactNode }): ReactNode {
  const sha = shortSha(ci.sha);
  return (
    <div className="tf-comment tf-comment-ci">
      <div
        className="tf-comment-open tf-comment-static"
        title={[`CI failed on PR #${ci.prNumber}${sha ? ` (${sha})` : ''}`, ...ci.checks.map((c) => `${c.name}: ${c.conclusion}`)].join('\n')}
      >
        <span className="tf-comment-ci-label">{ciFailureLabel(ci)}</span>
        <span className="tf-comment-body">{ci.checks.map((c) => c.name).join(', ')}</span>
      </div>
      {remove}
    </div>
  );
}

/**
 * A GitHub Draft the session removed (#427): where it was, what it said, the
 * session's reason, and Undo, which puts back the same draft.
 */
function RemovedDraftRow({ removal, onUndo }: { removal: DraftRemoval; onUndo: () => void }): ReactNode {
  const c = removal.row;
  const what = c.replyTo === null ? commentHeadline(c.body) : `Reply: ${c.body.split('\n')[0]}`;
  return (
    <div className="tf-comment tf-comment-removed">
      <div
        className="tf-comment-open tf-comment-static"
        title={`Removed by the session: ${commentLocation(c)}${removal.reason ? `\nWhy: ${removal.reason}` : ''}\n\n${commentWords(c.body)}`}
      >
        <span className="tf-comment-where">
          <span className="tf-name">{c.path.split('/').pop()}</span>
          <span className="tf-comment-line">{c.replyTo === null ? lineLabel(c) : `:${c.lineStart}`}</span>
        </span>
        <span className="tf-comment-body">
          Removed by the session · “{what}”
          {removal.reason ? <span className="tf-comment-reason">{removal.reason}</span> : null}
        </span>
      </div>
      <button
        type="button"
        className="tf-btn tf-comment-reopen"
        onClick={onUndo}
        aria-label={`Undo: put back the draft on ${commentLocation(c)}`}
      >
        Undo
      </button>
    </div>
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
