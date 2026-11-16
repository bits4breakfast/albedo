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
 * A PR's failing checks queued for Claude (#280, ciFailure.ts) are listed
 * here too, first, as the message carries them: "✗ CI failed · 2 checks" in
 * the head, and opened, each check with its conclusion and its link. When
 * the project fetches details (step 2), each check says which step failed,
 * and its log tail folds open under it: the first check's open, the rest
 * closed. "Fetching details…" while they come, one line on why when they
 * could not.
 *
 * Frozen like the box while a send is under way: the list can be read and
 * jumped from, not changed.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Disclosure } from '../Disclosure';
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
import { ciFailureLabel, detailOf, removeQueuedCi, shortSha, useQueuedCi, type QueuedCiFailure } from './ciFailure';
import { failedDetailsLine, type CheckDetail } from '../../gh/ciDetails';
import { openExternal } from '../../lib/openUrl';

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
  const ci = useQueuedCi(taskId);
  const [open, setOpen] = useState(false);
  const [editingIntro, setEditingIntro] = useState(false);
  const n = comments.length + code.length;
  if (n === 0 && ci === null) return null;
  return (
    <div className="tx-waiting" role="group" aria-label="Waiting to be sent">
      <div className="tx-waiting-bar">
        <button
          type="button"
          className="tx-waiting-head"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={ci ? ciTooltip(ci) : undefined}
        >
          <Disclosure open={open} />{' '}
          {ci ? <span className="tx-waiting-ci-mark">{ciFailureLabel(ci)}</span> : null}
          {ci && n > 0 ? ' + ' : null}
          {n > 0 ? `${n} Comment${n === 1 ? '' : 's'}` : null}
          <span className="tx-waiting-hint">{n + (ci ? 1 : 0) === 1 ? 'goes' : 'go'} with your next message</span>
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
          {/* In the order the message carries them: CI, code, then passages. */}
          {ci ? <CiItem taskId={taskId} failure={ci} frozen={frozen} /> : null}
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

/** The head's tooltip: the PR, the commit and every failing check. */
function ciTooltip(f: QueuedCiFailure): string {
  const sha = shortSha(f.sha);
  return [`CI failed on PR #${f.prNumber}${sha ? ` (${sha})` : ''}`, ...f.checks.map((c) => `${c.name}: ${c.conclusion}`)].join('\n');
}

/** The queued CI failure: the PR and commit, each failing check with Open, and Remove. */
function CiItem({ taskId, failure, frozen }: { taskId: number; failure: QueuedCiFailure; frozen: boolean }): ReactNode {
  const sha = shortSha(failure.sha);
  const details = failure.details;
  // Which logs are open, by check name; a check not named here takes the
  // default: open for the first check that has a log, closed for the rest.
  const [shown, setShown] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const firstWithLog = failure.checks.find((c) => (detailOf(failure, c.name)?.log.length ?? 0) > 0)?.name;
  return (
    <li className="tx-waiting-item" data-kind="ci">
      <div className="tx-waiting-row">
        <div className="tx-waiting-where tx-waiting-ci-where" title={ciTooltip(failure)}>
          {/* The head says "CI failed · N checks"; here, which PR and commit. */}
          <span className="tx-waiting-ci-glyph" aria-hidden="true">✗</span> PR #{failure.prNumber}
          {sha ? ` · ${sha}` : ''}
        </div>
        <button
          type="button"
          className="tx-btn tx-queued-act"
          onClick={() => removeQueuedCi(taskId, failure.sha)}
          disabled={frozen}
          aria-label="Remove the CI failure"
          title="Don’t send this failure to Claude"
        >
          Remove
        </button>
      </div>
      {details?.state === 'fetching' ? (
        <div className="tx-waiting-ci-note" role="status">
          Fetching details…
        </div>
      ) : details?.state === 'failed' ? (
        <div className="tx-waiting-ci-note">{failedDetailsLine(details.reason)}</div>
      ) : null}
      <ul className="tx-waiting-checks">
        {failure.checks.map((c) => {
          const d = detailOf(failure, c.name);
          const hasLog = (d?.log.length ?? 0) > 0;
          const open = hasLog && (shown.get(c.name) ?? c.name === firstWithLog);
          return (
            <li key={c.name}>
              <div className="tx-waiting-row">
                <div className="tx-waiting-comment">
                  {c.name}{' '}
                  <span className="tx-waiting-ci-conclusion">
                    {d?.step ? `step “${d.step}” · ${c.conclusion}` : `— ${c.conclusion}`}
                  </span>
                </div>
                {hasLog ? (
                  <button
                    type="button"
                    className="tx-btn tx-queued-act"
                    aria-expanded={open}
                    aria-label={`${open ? 'Hide' : 'Show'} the log of ${c.name}`}
                    onClick={() => setShown((m) => new Map(m).set(c.name, !open))}
                  >
                    <Disclosure open={open} /> Log
                  </button>
                ) : null}
                {c.url ? (
                  <button
                    type="button"
                    className="tx-btn tx-queued-act"
                    title={c.url}
                    aria-label={`Open the details of ${c.name}`}
                    onClick={() => void openExternal(c.url!)}
                  >
                    Open
                  </button>
                ) : null}
              </div>
              {open && d ? <LogTail detail={d} /> : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/** The end of a check's log, as it goes to Claude; what was cut said first. */
function LogTail({ detail }: { detail: CheckDetail }): ReactNode {
  return (
    <pre className="tx-waiting-ci-log" aria-label={`The end of the log of ${detail.name}`}>
      {detail.more > 0 ? (
        <span className="tx-waiting-ci-log-more">
          … {detail.more} more line{detail.more === 1 ? '' : 's'}
          {'\n'}
        </span>
      ) : null}
      {detail.log.join('\n')}
    </pre>
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
