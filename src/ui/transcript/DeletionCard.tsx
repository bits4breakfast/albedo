/**
 * The session asks to delete one of your comments on GitHub (#427): a
 * "waiting on you" card, as a preview's or a permission's is.
 *
 *   head   Waiting on You · Delete a comment on GitHub?            waited 0:42
 *   body   PR #412 · src/report/daily.ts:42 · posted 2 h ago
 *          <the comment>
 *          The session says: <reason>. Deleting on GitHub can't be undone.
 *   foot   [Keep It]  [Delete on GitHub]
 *
 * The session's `delete_posted_comment` call waits the whole time, and the
 * answer is its result (capture/githubGate.ts). Delete on GitHub asks GitHub
 * again that the comment is yours and on this PR, then deletes it; nothing
 * is deleted without that click. Esc in the terminal cancels the call, and
 * the card goes.
 */

import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import {
  answerDeletion,
  isDeletionAnswering,
  onDeletionChange,
  pendingDeletion,
  type PendingDeletion,
} from '../../capture/githubGate';
import { ago } from '../editor/commentLabels';
import { Waited } from './PromptCard';
import './promptCard.css';
import './deletionCard.css';

function subscribe(cb: () => void): () => void {
  return onDeletionChange(() => cb());
}

/** The deletion a task waits on, or null; and whether its answer is on its way. */
function useWaitingDeletion(taskId: number): { d: PendingDeletion | null; answering: boolean } {
  const d = useSyncExternalStore(subscribe, () => pendingDeletion(taskId), () => pendingDeletion(taskId));
  const answering = useSyncExternalStore(
    subscribe,
    () => (d ? isDeletionAnswering(d.requestId) : false),
    () => false,
  );
  return { d, answering };
}

/** "src/report/daily.ts:42", with the line GitHub has, or had. */
function placeOf(d: PendingDeletion): string {
  const line = d.comment.line ?? d.comment.originalLine;
  return line === null ? d.comment.path : `${d.comment.path}:${line}`;
}

/** The card for the deletion a task waits on, or nothing. */
export function DeletionCard({ taskId }: { taskId: number }): ReactNode {
  const { d, answering } = useWaitingDeletion(taskId);
  if (d === null) return null;
  return <Card key={d.requestId} d={d} answering={answering} />;
}

function Card({ d, answering }: { d: PendingDeletion; answering: boolean }): ReactNode {
  const [choice, setChoice] = useState<'delete' | 'keep' | null>(null);
  const busy = answering || choice !== null;
  const choose = (c: 'delete' | 'keep') => {
    if (busy) return;
    setChoice(c);
    void answerDeletion(d, c);
  };
  const posted = d.comment.createdAt > 0 ? ` · posted ${ago(d.comment.createdAt, Date.now())}` : '';
  return (
    <div className="tx-prompt" role="group" aria-label="Waiting on You: delete a comment on GitHub" data-focus-keeps-tab="">
      <div className="tx-prompt-head">
        <span className="tx-prompt-tag">
          <span className="status-dot" data-status="blocked" aria-hidden="true" />
          Waiting on You
        </span>
        <span className="pc-subject">· Delete a comment on GitHub?</span>
        <Waited at={d.at} />
      </div>
      <div className="pc-body">
        <div className="gd-quote">
          <div className="gd-where">
            PR #{d.pr.number} · {placeOf(d)}
            {posted}
          </div>
          <div className="gd-text">{d.comment.body}</div>
        </div>
        <div className="pc-note">
          {d.reason ? <>The session says: {d.reason.replace(/[.\s]+$/, '')}. </> : null}
          Deleting on GitHub can’t be undone.
        </div>
      </div>
      <div className="pc-foot">
        <div className="pc-actions gd-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => choose('keep')}>
            Keep It
          </button>
          <button
            type="button"
            className="btn gd-delete"
            disabled={busy}
            title="Albedo checks with GitHub that it is still your comment on this PR, then deletes it"
            onClick={() => choose('delete')}
          >
            Delete on GitHub
          </button>
        </div>
        {choice === 'delete' ? <div className="pc-note">Deleting on GitHub…</div> : null}
      </div>
    </div>
  );
}
