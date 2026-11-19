/**
 * A trigger that fired (#448): a "waiting on you" card, in the frame a
 * permission prompt's, a preview's and a deletion's card use.
 *
 *   Draft
 *     head   Waiting on You · PR #412 was merged          Trigger · Draft · 14:02
 *     body   <your template, then the facts -- editable here>
 *     foot   Not sent. Edit it here or Send as is.  [Skip] [Edit in Message Box] [Send ⌘↩]
 *
 *   Suggest (the approval only)
 *     head   Waiting on You · PR #415 is approved and its checks are green
 *     body   Approved by alice, 6 of 6 checks passed, no conflicts.
 *     foot   [Skip] [Squash and Merge…]
 *
 * Nothing here runs without its click:
 *   - **Send** goes through the send gateway as a reminder's card does
 *     (`sendReminderText`): now when the session is idle, else held in the
 *     outbox -- until the turn ends, or the session is started -- never typed
 *     into a prompt.
 *   - **Edit in Message Box** puts the text in the task's message box; the
 *     card stays, folded, until a message carrying it is sent.
 *   - **Squash and Merge…** opens the task bar's own dialog, which asks again
 *     before anything merges; the card goes once the merge is done.
 *   - **Skip** removes the card. Nothing else.
 *
 * A CI draft's failure is the CI queue's copy while it holds the same commit
 * (with the step and log tail CI Details fetched); once the draft goes, by
 * Send or into the message box, that commit is handled there too, as Ask
 * Claude to Fix does, so Claude is not told twice.
 */

import { useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { TaskStatus } from '../../types';
import { getPrStatus, usePrStatusVersion } from '../../gh/prStore';
import { prAction } from '../../gh/prAction';
import { readyToMerge } from '../../triggers/detect';
import { draftText } from '../../triggers/facts';
import {
  editTriggerCard,
  markTriggerInBox,
  requestTriggerMerge,
  resolveTriggerCard,
  useTriggerCards,
  type TriggerCard as Card,
} from '../../triggers/store';
import { insertIntoComposer } from '../transcript/composerBridge';
import { queuedCiOf, removeQueuedCi, useQueuedCi } from '../transcript/ciFailure';
import { sendReminderText } from '../reminders/send';
import '../transcript/promptCard.css';
import './triggers.css';

/** The cards waiting on a task, oldest first. */
export function TriggerCards({ taskId, status }: { taskId: number; status: TaskStatus | null }): ReactNode {
  const cards = useTriggerCards(taskId);
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((c) => (
        <TriggerCard key={c.id} card={c} taskId={taskId} status={status} />
      ))}
    </>
  );
}

/** "14:02" today, "Nov 18 14:02" before. */
function firedAt(at: number, now: Date): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

type Note = { tone: 'info' | 'error'; text: string } | null;

export function TriggerCard({ card, taskId, status }: { card: Card; taskId: number; status: TaskStatus | null }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const queued = useQueuedCi(taskId);
  usePrStatusVersion();
  const draft = card.mode === 'draft';
  // Your edit, held here: typing redraws this card only. The store keeps it
  // too (written soon after, and on the way out), never re-telling the list.
  const [edited, setEdited] = useState<string | undefined>(card.text);
  const text = edited ?? draftText(card, queued);
  const fetching =
    card.event === 'ciFailed' && edited === undefined && queued !== null && queued.sha === card.sha && queued.details?.state === 'fetching';

  /** The CI failure this draft carries is handled: it went, or it is in the box. */
  const handled = () => {
    if (card.event === 'ciFailed' && card.sha) removeQueuedCi(taskId, card.sha);
  };

  const send = async () => {
    if (busy) return;
    const body = (edited ?? draftText(card, queuedCiOf(taskId))).trim();
    if (!body) {
      setNote({ tone: 'error', text: 'There is nothing to send.' });
      return;
    }
    setBusy(true);
    try {
      const out = await sendReminderText({ id: taskId, status: status ?? 'idle' }, body);
      if (out === 'failed') {
        setNote({ tone: 'error', text: 'Could not send it. The session may not be running; try again.' });
        return;
      }
      handled();
      resolveTriggerCard(taskId, card.id);
    } catch (err) {
      console.warn('[triggers] send failed:', err);
      setNote({ tone: 'error', text: 'Could not send it. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  const toBox = () => {
    const body = (edited ?? draftText(card, queuedCiOf(taskId))).trim();
    const key = body.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
    if (!body || !key) {
      setNote({ tone: 'error', text: 'There is nothing to move.' });
      return;
    }
    if (!insertIntoComposer({ taskId, text: body })) {
      setNote({ tone: 'error', text: 'The message box is not open for this task.' });
      return;
    }
    handled();
    markTriggerInBox(taskId, card.id, key);
    setNote(null);
  };

  const merge = () => {
    if (!requestTriggerMerge(taskId)) {
      setNote({ tone: 'error', text: 'Squash and Merge isn’t offered for this PR right now. The task bar shows why.' });
    }
  };

  const pr = getPrStatus(taskId) ?? null;
  const samePr = pr !== null && pr.number === card.prNumber;
  const mergeable = samePr && readyToMerge(pr);
  const action = samePr ? prAction(pr) : null;
  const mergeNote =
    card.mode === 'suggest' && !mergeable
      ? samePr && pr.state === 'merged'
        ? `PR #${card.prNumber} was merged meanwhile.`
        : action?.kind === 'blocked'
          ? `${action.reason}.`
          : 'Can’t merge right now. The task bar shows the PR as it is.'
      : null;

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.metaKey && !e.altKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      void send();
    }
  };

  const meta = `Trigger · ${draft ? 'Draft' : 'Suggest'} · ${firedAt(card.at, new Date())}`;

  return (
    <div
      className="tx-prompt tg-card"
      role="group"
      aria-label={`Waiting on You: ${card.subject}`}
      data-focus-keeps-tab=""
      data-trigger={card.event}
    >
      <div className="tx-prompt-head">
        <span className="tx-prompt-tag">
          <span className="status-dot" data-status="blocked" aria-hidden="true" />
          Waiting on You
        </span>
        <span className="pc-subject">· {card.subject}</span>
        <span className="tg-meta" title={`Fired ${new Date(card.at).toLocaleString()}`}>
          {meta}
        </span>
      </div>
      <div className="pc-body">
        {/* It no longer applies; kept because the text is yours. */}
        {card.stale ? (
          <div className="pc-note pc-note-warn" role="status">
            {card.stale} Your edit is kept: Send it as it is, or Skip.
          </div>
        ) : null}
        {card.why ? <div className="tg-why">{card.why}</div> : null}
        {draft && !card.inBox ? (
          <textarea
            className="tg-msg"
            aria-label="The drafted message"
            value={text}
            rows={Math.min(10, text.split('\n').length + 1)}
            disabled={busy}
            onChange={(e) => {
              setEdited(e.target.value);
              editTriggerCard(taskId, card.id, e.target.value);
            }}
            onKeyDown={onKey}
          />
        ) : null}
        {draft && card.inBox ? (
          <div className="pc-note">Your draft is in the message box. This card goes when a message carrying it is sent, or Skip it.</div>
        ) : null}
        {fetching ? <div className="pc-note">CI Details is still fetching the failing step and log. They are added when they arrive.</div> : null}
      </div>
      <div className="pc-foot">
        <div className="pc-actions tg-actions">
          {draft && !card.inBox ? <span className="tg-note">Not sent. Edit it here or Send as is.</span> : null}
          {mergeNote ? <span className="tg-note">{mergeNote}</span> : null}
          <button type="button" className="btn" disabled={busy} onClick={() => resolveTriggerCard(taskId, card.id)} title="Dismiss this card. Nothing is sent">
            Skip
          </button>
          {draft && !card.inBox ? (
            <>
              <button type="button" className="btn" disabled={busy} onClick={toBox} title="Move it to the message box, to send with it">
                Edit in Message Box
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void send()}
                title={
                  status === 'running'
                    ? 'A turn is running: it waits and is sent when the turn ends'
                    : status === 'blocked'
                      ? 'Claude is waiting on you: it is sent once that is answered'
                      : 'Send it to Claude now'
                }
              >
                Send ⌘↩
              </button>
            </>
          ) : null}
          {card.mode === 'suggest' && mergeable ? (
            <button
              type="button"
              className="btn btn-primary"
              aria-haspopup="dialog"
              onClick={merge}
              title={`Opens Squash and Merge for PR #${card.prNumber}, which asks before anything merges`}
            >
              Squash and Merge…
            </button>
          ) : null}
        </div>
        {note ? (
          <div className={note.tone === 'error' ? 'pc-note pc-note-warn' : 'pc-note'} role="status">
            {note.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}
