/**
 * A mockup waiting for the user's approval (#348): the "waiting on you" card
 * of a plan (#272), with the page in place of the plan document.
 *
 *   head   Waiting on You · Preview                              waited 0:42
 *   body   <title>: <question>
 *          [v1][v2]  Changed since v1: <note>   [Light|Dark] [Comment on a Spot] [Open Large]
 *          the page, sandboxed (PreviewFrame)
 *          the comments, and a field to add one
 *   foot   [Send N Comments]  [Approve]  [Answer in Terminal]
 *
 * The session's `show_preview` call is waiting the whole time, and the answer
 * is its result (capture/previewGate.ts). A click writes the answer file only
 * while that exact call still waits; one made after it ended -- answered or
 * cancelled in the terminal -- is refused before anything is written.
 *
 * There is no Deny: a mockup you do not want is a comment. Esc in the
 * terminal cancels the call, and the card goes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { Preview, PreviewOutcome } from '../../types';
import { answerPreview } from '../../capture/previewGate';
import { resolvedTheme } from '../theme';
import { Waited } from '../transcript/PromptCard';
import { PreviewFrame, type FramePin } from './PreviewFrame';
import type { PreviewScheme } from './frameDoc';
import {
  addPreviewComment,
  composeApproval,
  composeChanges,
  inAnswerOrder,
  nextPin,
  removePreviewComment,
  usePreviewComments,
  type PreviewComment,
} from './previewComments';
import { usePreviewVersions, useWaitingPreview } from './usePreviews';
import '../transcript/promptCard.css';
import './preview.css';

type SendState = 'idle' | 'sending' | 'sent' | 'refused' | 'unacknowledged';

/** The card for whatever preview the task is waiting on, or nothing. */
export function PreviewCard({
  taskId,
  onAnswerInTerminal,
}: {
  taskId: number;
  onAnswerInTerminal: ((taskId: number) => void) | undefined;
}): ReactNode {
  const preview = useWaitingPreview(taskId);
  if (preview === null) return null;
  // Keyed by call: picks and the sent state belong to one call only.
  return <WaitingPreview key={preview.requestId} preview={preview} onAnswerInTerminal={onAnswerInTerminal} />;
}

/** "approved", "changes requested", …: how a version ended, in words. */
export function outcomeText(o: PreviewOutcome): string {
  switch (o) {
    case 'pending':
      return 'waiting on you';
    case 'approved':
      return 'approved';
    case 'changes':
      return 'changes requested';
    case 'cancelled':
      return 'cancelled';
  }
}

function WaitingPreview({
  preview,
  onAnswerInTerminal,
}: {
  preview: Preview;
  onAnswerInTerminal: ((taskId: number) => void) | undefined;
}): ReactNode {
  const stored = usePreviewVersions(preview.taskId, preview.title);
  // The waiting one is always there, even before the stored list is read.
  const versions = useMemo(() => {
    const list = (stored ?? []).filter((v) => v.version !== preview.version);
    return [...list, preview].sort((a, b) => a.version - b.version);
  }, [stored, preview]);
  const [shownVersion, setShownVersion] = useState(preview.version);
  const shown = versions.find((v) => v.version === shownVersion) ?? preview;

  const [scheme, setScheme] = useState<PreviewScheme>(() => resolvedTheme());
  const [commentMode, setCommentMode] = useState(false);
  const [large, setLarge] = useState(false);
  const [draftPin, setDraftPin] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState('');
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const comments = usePreviewComments(preview.requestId);
  const ordered = useMemo(() => inAnswerOrder(comments), [comments]);

  const [send, setSend] = useState<SendState>('idle');
  const sentRef = useRef(false);
  const locked = send !== 'idle';

  const submit = (outcome: 'approved' | 'changes', text: string) => {
    // The ref, not `locked`: two clicks inside one render. One click, one answer.
    if (sentRef.current) return;
    sentRef.current = true;
    setSend('sending');
    // 'taken' normally unmounts the card first: the call is retired at once.
    void answerPreview(preview, outcome, text).then((r) =>
      setSend(r === 'taken' ? 'sent' : r === 'refused' ? 'refused' : 'unacknowledged'),
    );
  };

  const addComment = () => {
    const added = addPreviewComment(preview.requestId, { version: shown.version, pin: draftPin, text: draft });
    if (!added) return;
    setDraft('');
    setDraftPin(null);
  };

  const pins: FramePin[] = [
    ...comments.filter((c) => c.version === shown.version && c.pin).map((c) => ({ n: c.pin!.n, x: c.pin!.x, y: c.pin!.y })),
    ...(draftPin ? [{ n: null, ...draftPin }] : []),
  ];

  useEffect(() => {
    if (draftPin) fieldRef.current?.focus();
  }, [draftPin]);

  const onCardKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (draftPin) {
      setDraftPin(null);
      e.stopPropagation();
    } else if (large) {
      setLarge(false);
      e.stopPropagation();
    }
  };

  const nextN = nextPin(comments, shown.version);
  const answersCount = comments.length;

  return (
    <div
      className={large ? 'tx-prompt pv-card pv-card-large' : 'tx-prompt pv-card'}
      role="group"
      aria-label="Waiting on You: preview"
      data-focus-keeps-tab=""
      onKeyDown={onCardKey}
    >
      <div className="tx-prompt-head">
        <span className="tx-prompt-tag">
          <span className="status-dot" data-status="blocked" aria-hidden="true" />
          Waiting on You
        </span>
        <span className="pc-subject">· Preview</span>
        <Waited at={preview.createdAt} />
      </div>

      <div className="pc-body pv-body">
        <div className="tx-prompt-q pv-q">
          <span className="pv-title">{preview.title}</span>
          {preview.question ? <span className="pv-question">: {preview.question}</span> : null}
        </div>
        <PreviewBar
          versions={versions}
          shown={shown}
          onShow={setShownVersion}
          scheme={scheme}
          onScheme={setScheme}
          extra={
            <>
              <button
                type="button"
                className="pv-btn"
                aria-pressed={commentMode}
                disabled={locked}
                title="Click the page to drop a numbered pin, then say what to change there"
                onClick={() => {
                  setCommentMode((m) => !m);
                  setDraftPin(null);
                }}
              >
                Comment on a Spot
              </button>
              <button
                type="button"
                className="pv-btn"
                aria-pressed={large}
                title={large ? 'Back to the card (Esc)' : 'Show the page full height in the reading pane'}
                onClick={() => setLarge((l) => !l)}
              >
                {large ? 'Close Large' : 'Open Large'}
              </button>
            </>
          }
        />
        <PreviewFrame
          html={shown.html}
          title={`${preview.title}, v${shown.version}`}
          scheme={scheme}
          large={large}
          commentMode={commentMode && !locked}
          pins={pins}
          onPlace={(x, y) => setDraftPin({ x, y })}
        />
        {shown.html.length === 0 ? <div className="pc-note pc-note-warn">Albedo could not read this version’s page.</div> : null}
        <CommentList
          comments={ordered}
          shownVersion={shown.version}
          locked={locked}
          onRemove={(id) => removePreviewComment(preview.requestId, id)}
        />
        {!locked ? (
          <div className="pv-add">
            {draftPin ? (
              <span className="pc-pin pv-add-pin" aria-hidden="true">
                {nextN}
              </span>
            ) : null}
            <textarea
              ref={fieldRef}
              className="pv-add-input"
              rows={1}
              value={draft}
              placeholder={
                draftPin
                  ? `Comment on pin ${nextN}, on v${shown.version}…`
                  : commentMode
                    ? 'Click the page to drop a pin, or comment on the whole page…'
                    : `Comment on v${shown.version}…`
              }
              aria-label={draftPin ? `Comment on pin ${nextN}` : `Comment on version ${shown.version}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  addComment();
                }
              }}
            />
            <button type="button" className="btn" disabled={draft.trim().length === 0} onClick={addComment}>
              Add
            </button>
            {draftPin ? (
              <button type="button" className="btn btn-ghost" onClick={() => setDraftPin(null)}>
                Cancel
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="pc-foot">
        <div className="pc-options" role="group" aria-label="Answers to the preview">
          {answersCount > 0 ? (
            <button
              type="button"
              className="pc-option pc-send"
              disabled={locked}
              onClick={() => submit('changes', composeChanges(comments))}
            >
              <span className="pc-option-text">
                <span className="pc-option-label">
                  Send {answersCount} Comment{answersCount === 1 ? '' : 's'}
                </span>
                <span className="pc-option-desc">Changes requested on {versionsOf(comments)}</span>
              </span>
            </button>
          ) : null}
          <button
            type="button"
            className="pc-option"
            disabled={locked}
            onClick={() => submit('approved', composeApproval(shown.version, preview.version))}
          >
            <span className="pc-option-text">
              <span className="pc-option-label">Approve</span>
              <span className="pc-option-desc">Build v{shown.version} as shown</span>
            </span>
          </button>
          {onAnswerInTerminal ? (
            <button type="button" className="pc-option" onClick={() => onAnswerInTerminal(preview.taskId)}>
              <span className="pc-option-text">
                <span className="pc-option-label">Answer in Terminal</span>
                <span className="pc-option-desc">Esc there cancels it</span>
              </span>
            </button>
          ) : null}
        </div>
        <SendNote state={send} />
      </div>
    </div>
  );
}

function versionsOf(comments: readonly PreviewComment[]): string {
  return [...new Set(comments.map((c) => c.version))]
    .sort((a, b) => b - a)
    .map((v) => `v${v}`)
    .join(' and ');
}

function SendNote({ state }: { state: SendState }): ReactNode {
  if (state === 'idle') return null;
  const text =
    state === 'sending'
      ? 'Sending to Claude Code…'
      : state === 'sent'
        ? 'Answered.'
        : state === 'refused'
          ? 'Not sent: this preview is no longer waiting. Check the terminal.'
          : 'Claude Code did not take the answer — it was probably cancelled in the terminal. Check there.';
  const warn = state === 'refused' || state === 'unacknowledged';
  return <div className={warn ? 'pc-note pc-note-warn' : 'pc-note'}>{text}</div>;
}

/**
 * The row above the page: the versions, the note on the one shown, Light /
 * Dark, and whatever else the caller puts at its end.
 */
export function PreviewBar({
  versions,
  shown,
  onShow,
  scheme,
  onScheme,
  extra,
}: {
  versions: readonly Preview[];
  shown: Preview;
  onShow: (version: number) => void;
  scheme: PreviewScheme;
  onScheme: (s: PreviewScheme) => void;
  extra: ReactNode;
}): ReactNode {
  return (
    <div className="pv-bar">
      {versions.length > 1 ? (
        <span className="pv-seg" role="group" aria-label="Version">
          {versions.map((v) => (
            <button
              key={v.version}
              type="button"
              aria-pressed={v.version === shown.version}
              title={`v${v.version} · ${outcomeText(v.outcome)}`}
              onClick={() => onShow(v.version)}
            >
              v{v.version}
            </button>
          ))}
        </span>
      ) : (
        <span className="pv-only">v{shown.version}</span>
      )}
      {shown.note ? (
        <span className="pv-note" title={shown.note}>
          {shown.version > 1 ? `Changed since v${shown.version - 1}: ` : ''}
          {shown.note}
        </span>
      ) : null}
      <span className="pv-spacer" />
      <span className="pv-seg" role="group" aria-label="The page's color scheme">
        <button type="button" aria-pressed={scheme === 'light'} onClick={() => onScheme('light')}>
          Light
        </button>
        <button type="button" aria-pressed={scheme === 'dark'} onClick={() => onScheme('dark')}>
          Dark
        </button>
      </span>
      {extra}
    </div>
  );
}

function CommentList({
  comments,
  shownVersion,
  locked,
  onRemove,
}: {
  comments: readonly PreviewComment[];
  shownVersion: number;
  locked: boolean;
  onRemove: (id: string) => void;
}): ReactNode {
  if (comments.length === 0) return null;
  return (
    <ul className="pv-comments" aria-label="Your comments, not sent yet">
      {comments.map((c) => (
        <li key={c.id} className="pv-comment">
          {c.pin ? (
            <span className="pc-pin" title={`Pin ${c.pin.n}: about ${c.pin.x}% across, ${c.pin.y}% down`}>
              {c.pin.n}
            </span>
          ) : (
            <span className="pv-comment-plain" aria-hidden="true">
              ·
            </span>
          )}
          <span className="pv-comment-text">
            {c.version !== shownVersion ? <span className="pv-comment-v">v{c.version} </span> : null}
            {c.text}
          </span>
          <button
            type="button"
            className="pc-tray-act"
            disabled={locked}
            aria-label={`Remove the comment ${c.pin ? `on pin ${c.pin.n}` : ''}`}
            onClick={() => onRemove(c.id)}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}
