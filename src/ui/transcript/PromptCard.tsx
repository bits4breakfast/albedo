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
 *
 * A plan to approve (#272) reads as a plan: the question as markdown, cut to
 * three lines; the .md file it names, or Claude Code's own plan mode's plan,
 * as a document (PlanDocument.tsx) that can be commented on; the answers in
 * one row at the foot that never scrolls away. Comments wait on the card
 * until "Send N Comments" -- a click -- sends them as one answer.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ANSWER_WINDOW_S,
  PLAN_TOOL,
  answerPrompt,
  answerWindowClosed,
  isAnswerable,
  onPromptChange,
  pendingPrompt,
  permissionDecision,
  planDecision,
  questionDecision,
  typedAnswerDecision,
  type HookDecision,
  type PendingPrompt,
  type PermissionChoice,
  type PromptQuestion,
  type QuestionPick,
  type SuggestedRule,
} from '../../capture/hookEvents';
import { isTrustWaiting, onTrustWaiting } from '../../capture/workspaceTrust';
import { useOpenFile } from '../editor/openFile';
import { Markdown } from './Markdown';
import { PlanDocument } from './PlanDocument';
import { inDocumentOrder, planCommentKey, usePlanComments } from './planComments';
import {
  PLAN_MAX_BYTES,
  composeComments,
  isRecommended,
  planPathIn,
  readPlanFile,
  reviseLabel,
  sizeText,
  splitPath,
  type PlanFile,
} from './planDoc';
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

  // Claude Code's trust dialog comes before any hook, so it is never a
  // `prompt`; it has its own source (capture/workspaceTrust.ts).
  const [trust, setTrust] = useState(() => isTrustWaiting(taskId));
  useEffect(() => {
    setTrust(isTrustWaiting(taskId));
    return onTrustWaiting((id, waiting) => {
      if (id === taskId) setTrust(waiting);
    });
  }, [taskId]);

  if (prompt === null) return trust ? <TrustCard taskId={taskId} onAnswerInTerminal={onAnswerInTerminal} /> : null;
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

  const notes = (
    <>
      {/* Still waiting, but past the hour the card can answer in (#246). */}
      {prompt.kind !== 'notice' && send === 'idle' && answerWindowClosed(prompt, now) ? (
        <div className="pc-note">Too late to answer here: Albedo can pass on an answer for an hour only. Answer it in the terminal.</div>
      ) : null}
      <SendNote state={send} />
    </>
  );

  const planMode = prompt.kind === 'permission' && prompt.toolName === PLAN_TOOL;
  // One question's header ("Plan") reads as the card's subject, in its head.
  const subject =
    prompt.kind === 'question' && prompt.questions.length === 1 ? prompt.questions[0]?.header ?? null : planMode ? 'Plan' : null;

  return (
    /* Options, a text field and buttons: Tab walks between them. */
    <div className="tx-prompt" role="status" aria-label="Waiting on You" data-focus-keeps-tab="">
      <div className="tx-prompt-head">
        <span className="tx-prompt-tag">
          <span className="status-dot" data-status="blocked" aria-hidden="true" />
          Waiting on You
        </span>
        {subject ? <span className="pc-subject">· {subject}</span> : null}
        <Waited at={prompt.at} />
        {onAnswerInTerminal ? (
          <button type="button" className="btn btn-ghost" onClick={() => onAnswerInTerminal(taskId)}>
            Answer in Terminal
          </button>
        ) : null}
      </div>

      {prompt.kind === 'question' ? (
        <QuestionBody
          taskId={taskId}
          prompt={prompt}
          answerable={answerable}
          locked={locked}
          onSubmit={submit}
          notes={notes}
          headed={subject !== null}
        />
      ) : prompt.kind === 'permission' && planMode ? (
        <PlanModeBody taskId={taskId} prompt={prompt} answerable={answerable} locked={locked} onSubmit={submit} notes={notes} />
      ) : prompt.kind === 'permission' ? (
        <>
          <div className="pc-body">
            <div className="tx-prompt-q">
              Needs Permission: <span className="tx-prompt-cmd">{prompt.summary}</span>
            </div>
          </div>
          <div className="pc-foot">
            {answerable ? <PermissionButtons prompt={prompt} locked={locked} onChoose={(c) => submit(permissionDecision(prompt, c))} /> : null}
            {notes}
          </div>
        </>
      ) : (
        <>
          <div className="pc-body">
            <div className="tx-prompt-q">{prompt.message}</div>
          </div>
          <div className="pc-foot">{notes}</div>
        </>
      )}
    </div>
  );
}

/** "48s", "3m", "1h 5m": how long the prompt has waited. */
export function waitedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

export function Waited({ at }: { at: number }): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Every second while it reads in seconds, then every half minute.
    const t = window.setTimeout(() => setNow(Date.now()), now - at < 60_000 ? 1_000 : 30_000);
    return () => window.clearTimeout(t);
  }, [now, at]);
  const since = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <span className="pc-waited" title={`Waiting since ${since}`}>
      {waitedText(now - at)}
    </span>
  );
}

/**
 * Claude Code wants to know whether to trust the folder before it starts. Only
 * the terminal can answer: no hook is running yet to take a decision file.
 */
function TrustCard({
  taskId,
  onAnswerInTerminal,
}: {
  taskId: number;
  onAnswerInTerminal: ((taskId: number) => void) | undefined;
}): ReactNode {
  return (
    <div className="tx-prompt" role="status" aria-label="Waiting on You">
      <div className="tx-prompt-head">
        <span className="tx-prompt-tag">
          <span className="status-dot" data-status="blocked" aria-hidden="true" />
          Waiting on You
        </span>
        {onAnswerInTerminal ? (
          <button type="button" className="btn btn-primary" onClick={() => onAnswerInTerminal(taskId)}>
            Answer in Terminal
          </button>
        ) : null}
      </div>
      <div className="tx-prompt-q">Claude Code is asking whether to trust this folder.</div>
      <div className="pc-note">
        It can only be answered in the terminal. Choose “Yes, I trust this folder” there (↓, then Enter): Enter alone
        picks the highlighted “No, exit”.
      </div>
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
// A plan to read (#272)
// ---------------------------------------------------------------------------

/** The plan file a question names, read when it appears; null while there is none to show. */
function usePlanFile(path: string | null): PlanFile | null {
  const [file, setFile] = useState<PlanFile | null>(null);
  useEffect(() => {
    setFile(null);
    if (path === null) return;
    let live = true;
    void readPlanFile(path).then((f) => {
      if (live) setFile(f);
    });
    return () => {
      live = false;
    };
  }, [path]);
  return file;
}

/** The document for the file a question names, or null when there is none to show. */
function QuestionDocument({
  path,
  file,
  commentKey,
  locked,
}: {
  path: string;
  file: PlanFile;
  commentKey: string | null;
  locked: boolean;
}): ReactNode {
  const open = useOpenFile();
  const { name, folder } = splitPath(path);
  return (
    <PlanDocument
      name={name}
      folder={folder}
      // A click is the ask (outsideFile.ts); read-only, as it is shown here.
      onOpen={() => open({ path: file.path, line: null }, { activated: true, readOnly: true })}
      text={file.text}
      note={file.truncated ? `Showing the first ${sizeText(PLAN_MAX_BYTES)} of ${sizeText(file.size)}. Open shows all of it.` : null}
      commentKey={commentKey}
      locked={locked}
    />
  );
}

/**
 * "Send N Comments": the comments, composed into one answer (planDoc.ts).
 * Shown only while there are comments; sends only on its click.
 */
function SendComments({
  count,
  answersAs,
  locked,
  onSend,
}: {
  count: number;
  answersAs: string;
  locked: boolean;
  onSend: () => void;
}): ReactNode {
  return (
    <button type="button" className="pc-option pc-send" disabled={locked} onClick={onSend}>
      <span className="pc-option-text">
        <span className="pc-option-label">
          Send {count} Comment{count === 1 ? '' : 's'}
        </span>
        <span className="pc-option-desc">Answers “{answersAs}” with your comments</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

function QuestionBody({
  taskId,
  prompt,
  answerable,
  locked,
  onSubmit,
  notes,
  headed,
}: {
  taskId: number;
  prompt: Extract<PendingPrompt, { kind: 'question' }>;
  answerable: boolean;
  locked: boolean;
  onSubmit: (decision: HookDecision | null) => void;
  notes: ReactNode;
  /** The one question's header is in the card's head already. */
  headed: boolean;
}): ReactNode {
  const [picks, setPicks] = useState<QuestionPick[]>(() => prompt.questions.map(() => ({ labels: [], other: '' })));
  const decision = useMemo(() => questionDecision(prompt, picks), [prompt, picks]);

  // The plan a question points to: the first absolute .md path in its text.
  const path = useMemo(() => {
    for (const q of prompt.questions) {
      const p = planPathIn(q.question);
      if (p !== null) return p;
    }
    return null;
  }, [prompt.questions]);
  const file = usePlanFile(path);
  const single = prompt.questions.length === 1;
  // Comments are kept per waiting hook, and only one question takes them.
  const commentKey = answerable && single && prompt.requestId !== null ? planCommentKey(taskId, prompt.requestId) : null;
  const comments = usePlanComments(file ? commentKey : null);

  if (prompt.questions.length === 0) {
    return (
      <>
        <div className="pc-body">
          <div className="tx-prompt-q">Claude is asking a question.</div>
        </div>
        <div className="pc-foot">{notes}</div>
      </>
    );
  }

  const doc =
    path !== null && file !== null ? <QuestionDocument path={path} file={file} commentKey={commentKey} locked={locked} /> : null;

  if (!answerable) {
    // No hook waiting (a session started before this build, or the window
    // closed): the read-only list, as before.
    return (
      <>
        <div className="pc-body">
          {prompt.questions.map((q, i) => (
            <div key={i} className="tx-prompt-block">
              {q.header && !headed ? <div className="tx-prompt-sub">{q.header}</div> : null}
              <QuestionText text={q.question} />
              <ol className="tx-prompt-opts">
                {q.options.map((o, j) => (
                  <li key={j}>
                    <span className="tx-prompt-opt">{o.label}</span>
                    {o.description ? <span className="tx-prompt-desc"> — {o.description}</span> : null}
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {doc}
        </div>
        <div className="pc-foot">{notes}</div>
      </>
    );
  }

  // One single-select question answers on the click, as Enter does in the
  // terminal. Anything more needs a Submit, so a half-answered set is never sent.
  const first = prompt.questions[0]!;
  const oneClick = single && !first.multiSelect;

  const update = (i: number, next: QuestionPick) => {
    const all = picks.map((p, j) => (j === i ? next : p));
    setPicks(all);
    return all;
  };
  const onPick = (i: number) => (next: QuestionPick, commit: boolean) => {
    const all = update(i, next);
    if (oneClick && commit) onSubmit(questionDecision(prompt, all));
  };

  const submitRow = !oneClick ? (
    <div className="pc-actions">
      <button type="button" className="btn btn-primary" disabled={locked || decision === null} onClick={() => onSubmit(decision)}>
        Submit {prompt.questions.length > 1 ? 'Answers' : 'Answer'}
      </button>
      {decision === null && !locked ? <span className="pc-hint">Answer every question to submit.</span> : null}
    </div>
  ) : null;

  if (single) {
    // The question and its plan scroll; the options stay at the foot.
    const answersAs = reviseLabel(first.options.map((o) => o.label));
    const sendComments =
      comments.length > 0 && path !== null ? (
        <SendComments
          count={comments.length}
          answersAs={answersAs}
          locked={locked}
          onSend={() =>
            onSubmit(typedAnswerDecision(prompt, composeComments(answersAs, splitPath(path).name, inDocumentOrder(comments))))
          }
        />
      ) : null;
    return (
      <>
        <div className="pc-body">
          {first.header && !headed ? <div className="tx-prompt-sub">{first.header}</div> : null}
          <QuestionText text={first.question} multi={first.multiSelect} />
          {doc}
        </div>
        <div className="pc-foot">
          <OptionsRow q={first} pick={picks[0] ?? { labels: [], other: '' }} locked={locked} lead={sendComments} onPick={onPick(0)} />
          {submitRow}
          {notes}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="pc-body">
        {prompt.questions.map((q, i) => (
          <div key={i} className="tx-prompt-block" role="group" aria-label={q.question}>
            {q.header ? <div className="tx-prompt-sub">{q.header}</div> : null}
            <QuestionText text={q.question} multi={q.multiSelect} />
            <OptionsRow q={q} pick={picks[i] ?? { labels: [], other: '' }} locked={locked} lead={null} onPick={onPick(i)} />
          </div>
        ))}
        {doc}
      </div>
      <div className="pc-foot">
        {submitRow}
        {notes}
      </div>
    </>
  );
}

/**
 * A question's text: regular weight, as markdown, cut to three lines with
 * Show All when it is longer.
 */
function QuestionText({ text, multi = false }: { text: string; multi?: boolean }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);

  return (
    <div className="tx-prompt-q pc-q">
      <div ref={ref} className={open ? 'pc-q-text' : 'pc-q-text pc-q-clamp'}>
        <Markdown text={text} />
      </div>
      {multi ? <span className="pc-multi">(choose any)</span> : null}
      {cut || open ? (
        <button type="button" className="pc-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show Less' : 'Show All'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A question's options in one row, wrapping only when narrow, with "Other…"
 * in the same row. `lead` goes first: "Send N Comments", when there are any.
 * The one option whose label ends "(Recommended)" is drawn as the suggestion.
 */
function OptionsRow({
  q,
  pick,
  locked,
  lead,
  onPick,
}: {
  q: PromptQuestion;
  pick: QuestionPick;
  locked: boolean;
  lead: ReactNode;
  /** `commit` is true for a deliberate single answer: an option click, or Enter in the text field. */
  onPick: (next: QuestionPick, commit: boolean) => void;
}): ReactNode {
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
    <div className="pc-options" role="group" aria-label={`Answers to: ${q.question}`}>
      {lead}
      {q.options.map((o, j) => {
        const on = pick.labels.includes(o.label);
        const cls = `pc-option${on ? ' pc-option-on' : ''}${isRecommended(o.label) ? ' pc-option-suggested' : ''}`;
        return (
          <button key={j} type="button" className={cls} aria-pressed={on} disabled={locked} onClick={() => toggle(o.label)}>
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
      <input
        className="pc-other"
        type="text"
        placeholder={q.multiSelect ? 'Other (optional)…' : 'Other…'}
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

// ---------------------------------------------------------------------------
// Claude Code's own plan mode: ExitPlanMode
// ---------------------------------------------------------------------------

function PlanModeBody({
  taskId,
  prompt,
  answerable,
  locked,
  onSubmit,
  notes,
}: {
  taskId: number;
  prompt: Extract<PendingPrompt, { kind: 'permission' }>;
  answerable: boolean;
  locked: boolean;
  onSubmit: (decision: HookDecision | null) => void;
  notes: ReactNode;
}): ReactNode {
  const commentKey = answerable && prompt.requestId !== null && prompt.plan ? planCommentKey(taskId, prompt.requestId) : null;
  const comments = usePlanComments(commentKey);
  const keepPlanning = 'Keep Planning';
  return (
    <>
      <div className="pc-body">
        <div className="tx-prompt-q pc-q">
          {prompt.plan ? 'Claude has finished planning and asks to start.' : 'Claude has finished planning and asks to start. The plan is too long to show here: read it in the terminal.'}
        </div>
        {prompt.plan ? (
          <PlanDocument name="Claude’s Plan" folder={null} onOpen={null} text={prompt.plan} note={null} commentKey={commentKey} locked={locked} />
        ) : null}
      </div>
      <div className="pc-foot">
        {answerable ? (
          <div className="pc-options" role="group" aria-label="Answers to the plan">
            {comments.length > 0 ? (
              <SendComments
                count={comments.length}
                answersAs={keepPlanning}
                locked={locked}
                onSend={() =>
                  onSubmit(planDecision(prompt, 'keep-planning', composeComments(keepPlanning, null, inDocumentOrder(comments))))
                }
              />
            ) : null}
            <button type="button" className="pc-option" disabled={locked} onClick={() => onSubmit(planDecision(prompt, 'approve'))}>
              <span className="pc-option-mark" aria-hidden="true">
                ○
              </span>
              <span className="pc-option-text">
                <span className="pc-option-label">Approve</span>
                <span className="pc-option-desc">Leave plan mode and start</span>
              </span>
            </button>
            <button type="button" className="pc-option" disabled={locked} onClick={() => onSubmit(planDecision(prompt, 'keep-planning'))}>
              <span className="pc-option-mark" aria-hidden="true">
                ○
              </span>
              <span className="pc-option-text">
                <span className="pc-option-label">{keepPlanning}</span>
                <span className="pc-option-desc">Claude stops and waits for what to change</span>
              </span>
            </button>
          </div>
        ) : null}
        {notes}
      </div>
    </>
  );
}

export default PromptCard;
