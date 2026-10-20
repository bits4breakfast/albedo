/**
 * What Claude is waiting on the user for, shown where the transcript is read,
 * and -- when a hook is waiting for it -- answerable right here.
 *
 * The transcript cannot show it: Claude Code writes a turn only when it ends,
 * and this turn is waiting. It comes from the hook events (capture/
 * hookEvents.ts), and so does the way back: a click writes a decision file the
 * session's own PermissionRequest hook is polling for. The pty is never typed
 * into, so a stale card cannot press a key in whatever dialog replaced it.
 *
 * The terminal dialog is untouched by any of this. It is drawn and usable the
 * whole time; whichever of the two answers first wins, and Claude Code kills
 * the waiting hook the moment the terminal does. "Answer in terminal" stays,
 * for everything the card does not offer.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ANSWER_WINDOW_S,
  answerPrompt,
  isAnswerable,
  onPromptChange,
  pendingPrompt,
  permissionDecision,
  questionDecision,
  type HookDecision,
  type PendingPrompt,
  type PermissionChoice,
  type PromptQuestion,
  type QuestionPick,
  type SuggestedRule,
} from '../../capture/hookEvents';
import './promptCard.css';

type SendState = 'idle' | 'sending' | 'sent' | 'refused' | 'unacknowledged';

/** Stable identity of one prompt: a new one resets the card's local state. */
function promptKey(p: PendingPrompt): string {
  return `${p.kind}|${p.at}|${p.kind === 'notice' ? '' : (p.requestId ?? '')}`;
}

/** Where a suggested rule would be written, in the words a user would look for. */
function destinationText(d: string): string {
  switch (d) {
    case 'session':
      return 'for this session only';
    case 'localSettings':
      return 'to .claude/settings.local.json';
    case 'projectSettings':
      return 'to .claude/settings.json';
    case 'userSettings':
      return 'to ~/.claude/settings.json';
    default:
      return `to ${d}`;
  }
}

function alwaysTitle(rules: readonly SuggestedRule[]): string {
  return rules.map((r) => `Adds ${r.label} ${destinationText(r.destination)}`).join('\n');
}

export function PromptCard({
  taskId,
  onAnswerInTerminal,
}: {
  taskId: number;
  onAnswerInTerminal: ((taskId: number) => void) | undefined;
}): ReactNode {
  const [prompt, setPrompt] = useState<PendingPrompt | null>(() => pendingPrompt(taskId));
  useEffect(() => {
    setPrompt(pendingPrompt(taskId));
    return onPromptChange((id, next) => {
      if (id === taskId) setPrompt(next);
    });
  }, [taskId]);

  if (prompt === null) return null;
  // Keyed by prompt: picks and the sent state belong to one prompt only, and
  // must not survive into the next one -- which may look identical.
  return <PromptBody key={promptKey(prompt)} taskId={taskId} prompt={prompt} onAnswerInTerminal={onAnswerInTerminal} />;
}

function PromptBody({
  taskId,
  prompt,
  onAnswerInTerminal,
}: {
  taskId: number;
  prompt: PendingPrompt;
  onAnswerInTerminal: ((taskId: number) => void) | undefined;
}): ReactNode {
  const [send, setSend] = useState<SendState>('idle');
  const sentRef = useRef(false);
  const [now, setNow] = useState(() => Date.now());

  // Re-render when the answer window closes, so the buttons go with it.
  useEffect(() => {
    const left = prompt.at + ANSWER_WINDOW_S * 1000 - Date.now();
    if (left <= 0) return;
    const t = window.setTimeout(() => setNow(Date.now()), left);
    return () => window.clearTimeout(t);
  }, [prompt.at]);

  const answerable = isAnswerable(prompt, prompt, now);
  const locked = send !== 'idle';

  const submit = (decision: HookDecision | null) => {
    // The ref, not `locked`: two clicks inside one render would both see the
    // same `locked`. One click, one answer.
    if (decision === null || sentRef.current) return;
    sentRef.current = true;
    setSend('sending');
    // 'taken' normally unmounts the card first: the prompt is retired at once.
    void answerPrompt(taskId, prompt, decision).then((r) =>
      setSend(r === 'taken' ? 'sent' : r === 'refused' ? 'refused' : 'unacknowledged'),
    );
  };

  return (
    <div className="tx-prompt" role="status" aria-label="Waiting on You">
      <div className="tx-prompt-head">
        <span className="tx-prompt-tag">
          <span className="status-dot" data-status="blocked" aria-hidden="true" />
          Waiting on You
        </span>
        {onAnswerInTerminal ? (
          <button type="button" className="btn btn-ghost" onClick={() => onAnswerInTerminal(taskId)}>
            Answer in Terminal
          </button>
        ) : null}
      </div>

      {prompt.kind === 'question' ? (
        <QuestionBody prompt={prompt} answerable={answerable} locked={locked} onSubmit={submit} />
      ) : prompt.kind === 'permission' ? (
        <>
          <div className="tx-prompt-q">
            Needs Permission: <span className="tx-prompt-cmd">{prompt.summary}</span>
          </div>
          {answerable ? <PermissionButtons prompt={prompt} locked={locked} onChoose={(c) => submit(permissionDecision(prompt, c))} /> : null}
        </>
      ) : (
        <div className="tx-prompt-q">{prompt.message}</div>
      )}

      <SendNote state={send} />
    </div>
  );
}

function SendNote({ state }: { state: SendState }): ReactNode {
  if (state === 'idle') return null;
  const text =
    state === 'sending'
      ? 'Sending to Claude Code…'
      : state === 'sent'
        ? 'Answered.'
        : state === 'refused'
          ? 'Not sent: this prompt was already answered or has changed. Check the terminal.'
          : 'Claude Code did not take the answer — it was probably answered in the terminal. Check there.';
  const warn = state === 'refused' || state === 'unacknowledged';
  return <div className={warn ? 'pc-note pc-note-warn' : 'pc-note'}>{text}</div>;
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

function PermissionButtons({
  prompt,
  locked,
  onChoose,
}: {
  prompt: Extract<PendingPrompt, { kind: 'permission' }>;
  locked: boolean;
  onChoose: (choice: PermissionChoice) => void;
}): ReactNode {
  return (
    <div className="pc-actions">
      <button type="button" className="btn btn-primary" disabled={locked} onClick={() => onChoose('allow')}>
        Allow
      </button>
      {prompt.alwaysAllow ? (
        <button
          type="button"
          className="btn"
          disabled={locked}
          title={alwaysTitle(prompt.alwaysAllow)}
          onClick={() => onChoose('allow-always')}
        >
          Allow, Don’t Ask Again
        </button>
      ) : null}
      <button
        type="button"
        className="btn"
        disabled={locked}
        title="Deny and stop, as “No” in the terminal does. Claude waits for you to say what to do instead."
        onClick={() => onChoose('deny')}
      >
        Deny
      </button>
      {prompt.alwaysAllow ? (
        // The rule in plain sight, not only in a tooltip: it is written to a
        // settings file, and may be narrower than what the terminal offers.
        <div className="pc-rule">
          “Don’t Ask Again” adds{' '}
          {prompt.alwaysAllow.map((r, i) => (
            <span key={i}>
              {i > 0 ? '; ' : null}
              <code className="pc-rule-code">{r.label}</code> {destinationText(r.destination)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

function QuestionBody({
  prompt,
  answerable,
  locked,
  onSubmit,
}: {
  prompt: Extract<PendingPrompt, { kind: 'question' }>;
  answerable: boolean;
  locked: boolean;
  onSubmit: (decision: HookDecision | null) => void;
}): ReactNode {
  const [picks, setPicks] = useState<QuestionPick[]>(() => prompt.questions.map(() => ({ labels: [], other: '' })));
  const decision = useMemo(() => questionDecision(prompt, picks), [prompt, picks]);

  if (prompt.questions.length === 0) return <div className="tx-prompt-q">Claude is asking a question.</div>;

  // One single-select question answers on the click, as Enter does in the
  // terminal. Anything more needs a Submit, so a half-answered set is never sent.
  const first = prompt.questions[0];
  const oneClick = prompt.questions.length === 1 && first !== undefined && !first.multiSelect;

  const update = (i: number, next: QuestionPick) => {
    const all = picks.map((p, j) => (j === i ? next : p));
    setPicks(all);
    return all;
  };

  return (
    <>
      {prompt.questions.map((q, i) => (
        <QuestionBlock
          key={i}
          q={q}
          pick={picks[i] ?? { labels: [], other: '' }}
          answerable={answerable}
          locked={locked}
          onPick={(next, commit) => {
            const all = update(i, next);
            if (oneClick && commit) onSubmit(questionDecision(prompt, all));
          }}
        />
      ))}
      {answerable && !oneClick ? (
        <div className="pc-actions">
          <button type="button" className="btn btn-primary" disabled={locked || decision === null} onClick={() => onSubmit(decision)}>
            Submit {prompt.questions.length > 1 ? 'Answers' : 'Answer'}
          </button>
          {decision === null && !locked ? <span className="pc-hint">Answer every question to submit.</span> : null}
        </div>
      ) : null}
    </>
  );
}

function QuestionBlock({
  q,
  pick,
  answerable,
  locked,
  onPick,
}: {
  q: PromptQuestion;
  pick: QuestionPick;
  answerable: boolean;
  locked: boolean;
  /** `commit` is true for a deliberate single answer: an option click, or Enter in the text field. */
  onPick: (next: QuestionPick, commit: boolean) => void;
}): ReactNode {
  if (!answerable) {
    // No hook waiting (a session started before this build, or the window
    // closed): the read-only list, as before.
    return (
      <div className="tx-prompt-block">
        {q.header ? <div className="tx-prompt-sub">{q.header}</div> : null}
        <div className="tx-prompt-q">{q.question}</div>
        <ol className="tx-prompt-opts">
          {q.options.map((o, j) => (
            <li key={j}>
              <span className="tx-prompt-opt">{o.label}</span>
              {o.description ? <span className="tx-prompt-desc"> — {o.description}</span> : null}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const toggle = (label: string) => {
    if (q.multiSelect) {
      const has = pick.labels.includes(label);
      onPick({ ...pick, labels: has ? pick.labels.filter((l) => l !== label) : [...pick.labels, label] }, false);
    } else {
      // Picking a label replaces typed text, and vice versa: one answer.
      onPick({ labels: [label], other: '' }, true);
    }
  };

  return (
    <div className="tx-prompt-block" role="group" aria-label={q.question}>
      {q.header ? <div className="tx-prompt-sub">{q.header}</div> : null}
      <div className="tx-prompt-q">
        {q.question}
        {q.multiSelect ? <span className="pc-multi"> (choose any)</span> : null}
      </div>
      <div className="pc-options">
        {q.options.map((o, j) => {
          const on = pick.labels.includes(o.label);
          return (
            <button
              key={j}
              type="button"
              className={on ? 'pc-option pc-option-on' : 'pc-option'}
              aria-pressed={on}
              disabled={locked}
              onClick={() => toggle(o.label)}
            >
              <span className="pc-option-mark" aria-hidden="true">
                {q.multiSelect ? (on ? '☑' : '☐') : on ? '●' : '○'}
              </span>
              <span className="pc-option-text">
                <span className="pc-option-label">{o.label}</span>
                {o.description ? <span className="pc-option-desc">{o.description}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      <input
        className="pc-other"
        type="text"
        placeholder={q.multiSelect ? 'Something else (optional)…' : 'Or type something…'}
        aria-label={`Type your own answer to: ${q.question}`}
        value={pick.other}
        disabled={locked}
        onChange={(e) =>
          onPick(q.multiSelect ? { ...pick, other: e.target.value } : { labels: [], other: e.target.value }, false)
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && pick.other.trim().length > 0) {
            e.preventDefault();
            onPick(pick, true);
          }
        }}
      />
    </div>
  );
}

export default PromptCard;
