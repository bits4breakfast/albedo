/**
 * One transcript row, rendered according to its `role`.
 *
 * Markdown in assistant text is rendered by a small hand-written subset
 * (paragraphs, fenced code, inline code, nested lists, quotes, emphasis, links as
 * plain text) that builds React nodes. There is no markdown dependency and no
 * `dangerouslySetInnerHTML` anywhere in this module, on purpose: model output
 * is untrusted content, and injecting it as HTML is the one security mistake
 * available here. Links are rendered as text rather than anchors for the same
 * reason -- a transcript is for reading, not for navigating somewhere a model
 * chose.
 */

import { memo, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { FileDiff, Message } from '../../types';
import { diffStrings, parseUnifiedDiff } from '../../lib/diff';
import { CollapsibleDiff, Disclosure, LinkifiedText, useActivate } from './Diff';
import { Markdown } from './Markdown';
import { lineCount } from './pastedText';
import { PassageRevealContext } from './passages';
import { foldQuote } from './transcriptQuotes';
import { DIFF_TOOLS, editPairsOf } from './editPairs';
import ToolChip, { FieldList, str, toolInput, toolResultText } from './ToolChip';
import { SHOW_PREVIEW_TOOL } from '../../capture/previewGate';
import { PreviewChip } from '../preview/PreviewChip';
import {
  imageSourceNote,
  isAllEnvelopes,
  isImagePlaceholder,
  parseUserBody,
  skillTextOf,
  systemRowText,
  withoutImageMarkers,
  type UserBlock,
} from './envelopes';
import {
  apiErrorOf,
  fullBodyOf,
  harnessInputOf,
  imageAt,
  imagesIn,
  isLocalCommandLine,
  peerMessageIdOf,
  senderTaskOf,
  skillSourceToolUseIdOf,
} from '../../capture';
import { useTaskOpener } from '../openTask';
import { dateText } from '../../reminders/when';
import { ReminderGlyph } from '../reminders/ReminderGlyph';
import { ApiErrorRetryContext } from './apiErrorRetry';
import { TryAgainButton } from '../TryAgain';

export interface MessageRowProps {
  message: Message;
  /** The paired `tool_result` row for a `tool_use`, when it has arrived. */
  result?: Message | null;
  /**
   * For a user row: the rest of the same message -- an attached image, the
   * note naming its file -- so it renders as one band. For a tool call: the
   * skill's text Claude Code wrote after a Skill call (#150). See groupRows.
   */
  extras?: readonly Message[];
}

export function MessageRow({ message, result = null, extras = [] }: MessageRowProps): ReactNode {
  // Input Claude Code wrote itself is nobody's message (#138): a /loop
  // wake-up with its re-sent prompt, or a note the harness gives the model.
  const harness = message.role === 'user' || message.role === 'system' ? harnessInputOf(message.rawJson) : null;
  if (harness === 'wakeup' || harness === 'scheduled-prompt') return <WakeupRow message={message} extras={extras} />;
  if (harness === 'note') return <SystemRow message={message} />;
  // A skill's text whose Skill call is not among the loaded rows (#150):
  // Claude Code wrote it, so it is never "You".
  if (message.role === 'user' && skillSourceToolUseIdOf(message.rawJson) !== null) {
    return <SkillTextRow message={message} extras={extras} />;
  }
  switch (message.role) {
    case 'user':
      return <UserRow message={message} extras={extras} />;
    case 'assistant':
      if (message.toolName === 'thinking') return <ThinkingRow message={message} />;
      // Claude Code's own line for a failed request (#338), not Claude's reply.
      return apiErrorOf(message.rawJson) !== null ? <ApiErrorRow message={message} /> : <AssistantRow message={message} />;
    case 'system':
      return isLocalCommandLine(message.rawJson) ? <LocalCommandRow message={message} /> : <SystemRow message={message} />;
    case 'tool_use':
      return <ToolUseRow message={message} result={result} extras={extras} />;
    case 'tool_result':
      // Normally consumed by its tool_use row; an orphan still deserves display.
      return <OrphanResultRow message={message} />;
    default:
      return null;
  }
}

/**
 * Rows are immutable once captured, so a row whose message, result and extras
 * are the same objects renders the same. Without this every live append
 * re-rendered (and re-tokenised) the whole transcript. `extras` is rebuilt by
 * groupRows on each pass, so it is compared element by element.
 */
function sameRow(a: MessageRowProps, b: MessageRowProps): boolean {
  if (a.message !== b.message || (a.result ?? null) !== (b.result ?? null)) return false;
  const ea = a.extras ?? [];
  const eb = b.extras ?? [];
  return ea.length === eb.length && ea.every((m, i) => m === eb[i]);
}

export const MemoMessageRow = memo(MessageRow, sameRow);

export default MessageRow;

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * A `user` row is not only what a human typed.
 *
 * Measured across real sessions, about a quarter of them are machine-generated
 * envelopes -- subagent completions, slash commands, injected context -- which
 * this pane used to print as raw XML. `parseUserBody` splits them out (see
 * envelopes.ts, which is the only place that knows those shapes) and each part
 * renders as what it actually is.
 *
 * Prose goes through the markdown renderer too. A human's stray asterisk
 * rendering as italic is a far smaller cost than a subagent's 60-line report
 * rendering as source, and ~9% of typed rows contain markdown anyway.
 */
type UserPart =
  | { kind: 'blocks'; blocks: UserBlock[] }
  | { kind: 'image'; src: string | null }
  | { kind: 'source'; path: string };

function UserRow({ message, extras }: { message: Message; extras: readonly Message[] }): ReactNode {
  const parts = useMemo<UserPart[]>(() => {
    const rows = [message, ...extras];
    // Claude Code marks where a picture went with `[Image #N]`. With the
    // picture itself on screen the marker says nothing, so it goes.
    const pictured = rows.some((m) => {
      const body = m.body ?? '';
      return isImagePlaceholder(body) || body.split('\n').some((l) => isImagePlaceholder(l));
    });
    const out: UserPart[] = [];
    const pushText = (text: string) => {
      const blocks = parseUserBody(pictured ? withoutImageMarkers(text) : text);
      if (blocks.length > 0) out.push({ kind: 'blocks', blocks });
    };
    for (const m of rows) {
      // Whole, not as stored: a cut body loses an envelope's closing tag.
      const body = fullBodyOf(m) ?? '';
      if (isImagePlaceholder(body)) {
        out.push({ kind: 'image', src: imageAt(m.rawJson, m.seq)?.src ?? null });
        continue;
      }
      const source = imageSourceNote(body);
      if (source !== null) {
        out.push({ kind: 'source', path: source });
        continue;
      }
      // A message sent mid-turn is one row: its text and an `[image]` line
      // per picture (see imagesIn). Each such line is its picture.
      const lines = body.split('\n');
      if (lines.length > 1 && lines.some((l) => isImagePlaceholder(l))) {
        const images = imagesIn(m.rawJson);
        let k = 0;
        let text: string[] = [];
        for (const l of lines) {
          if (!isImagePlaceholder(l)) {
            text.push(l);
            continue;
          }
          if (text.length > 0) pushText(text.join('\n'));
          text = [];
          out.push({ kind: 'image', src: images[k++]?.src ?? null });
        }
        if (text.length > 0) pushText(text.join('\n'));
        continue;
      }
      pushText(body);
    }
    return out;
  }, [message, extras]);

  // Set when another session sent this row: how its sender is found.
  const msgId = useMemo(() => peerMessageIdOf(message.rawJson), [message.rawJson]);

  if (parts.length === 0) return null;
  // Nothing a human typed or attached: drop the "you said" framing rather than
  // attributing a harness notification to the user.
  const machine = parts.every((p) => p.kind === 'blocks' && isAllEnvelopes(p.blocks));
  return (
    <div className={`tx-row ${machine ? 'tx-row-machine' : 'tx-row-user'}`} data-message-id={message.id}>
      <div className="tx-gutter">{machine ? '' : 'You'}</div>
      <div className="tx-content">
        {parts.map((p, i) =>
          p.kind === 'blocks' ? (
            p.blocks.map((b, j) => <UserBlockView key={`${i}-${j}`} block={b} msgId={msgId} />)
          ) : p.kind === 'image' ? (
            <AttachedImage key={i} src={p.src} />
          ) : (
            <div key={i} className="tx-img-source" title={p.path}>
              {p.path.split('/').pop()}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * An image you attached. A thumbnail in the band; click for the full size,
 * Esc or a click anywhere to close. Null `src` means the picture could not be
 * recovered from the transcript (another source type), which is said, not
 * hidden.
 */
function AttachedImage({ src }: { src: string | null }): ReactNode {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (src === null) return <div className="tx-img-missing">Image (not stored in the transcript)</div>;
  return (
    <>
      <button type="button" className="tx-img-thumb" onClick={() => setOpen(true)} title="Show full size">
        <img src={src} alt="Attached image" loading="lazy" />
      </button>
      {open ? (
        <div className="tx-lightbox" role="dialog" aria-modal="true" aria-label="Attached image" onClick={() => setOpen(false)}>
          <img src={src} alt="Attached image, full size" />
        </div>
      ) : null}
    </>
  );
}

function UserBlockView({ block, msgId = null }: { block: UserBlock; msgId?: string | null }): ReactNode {
  switch (block.kind) {
    case 'text':
      return <Markdown text={block.text} mentions={block.mentions} />;
    case 'task-notification':
      return <NotificationChip block={block} />;
    case 'agent-message':
      // A hand-back is a subagent's final report to its parent: its group in
      // the pane already shows that work, so it stays out of the row.
      return block.handback ? null : <PeerMessage block={block} msgId={msgId} />;
    case 'command':
      return (
        <div className="tx-cmd">
          <span className="tx-cmd-name">{block.name}</span>
          {block.args ? <span className="tx-cmd-args">{block.args}</span> : null}
        </div>
      );
    case 'action':
      return <ActionBlock block={block} />;
    case 'reminder':
      return <ReminderBlock block={block} />;
    case 'shell-input':
      return (
        <div className="tx-cmd tx-shell-in" title="Run in Claude Code's shell mode">
          <span className="tx-cmd-name">!</span>
          <span className="tx-shell-cmd">{block.command}</span>
        </div>
      );
    case 'shell-output':
      return <ShellOutput stdout={block.stdout} stderr={block.stderr} />;
    case 'cleared':
      return (
        <div className="tx-cleared" role="separator">
          <span>Context Cleared</span>
        </div>
      );
    case 'system-reminder':
      return <Collapsed label="Injected Context" text={block.text} />;
    case 'context':
      // Never seen in a transcript on the owner's machine, and never drawn
      // until the switch became exhaustive. Folded rather than hidden.
      return <Collapsed label="Attached Context" text={block.text} />;
    case 'skill':
      return <SkillBlock skill={block} />;
    case 'pasted': {
      // Counted as the message box's token counts them (a trailing line break
      // starts no line), so "+42 lines" in the box is "42 Lines" here (#155).
      const lines = lineCount(block.text);
      return <Collapsed label={`Pasted Text · ${lines} Line${lines === 1 ? '' : 's'}`} text={block.text} />;
    }
    case 'quote':
      return <QuoteBlock block={block} />;
    case 'output':
      return (
        <pre className="tx-pre tx-output">
          <LinkifiedText text={block.text} />
        </pre>
      );
    default: {
      // Every kind has a case: a kind added without one is a type error here,
      // not a block that silently draws nothing (`agent-message` was one).
      const unhandled: never = block;
      return unhandled;
    }
  }
}

/**
 * A passage you quoted to comment on it (#187): a compact quote above your
 * comment. A long one shows its first line and "+N lines", which opens it in
 * place; the quote itself takes you to the passage it came from and flashes
 * it there, when the pane can (`PassageRevealContext`).
 */
function QuoteBlock({ block }: { block: Extract<UserBlock, { kind: 'quote' }> }): ReactNode {
  const reveal = useContext(PassageRevealContext);
  const [open, setOpen] = useState(false);
  const { first, more } = foldQuote(block.text);
  const shown = open || more === 0 ? block.text : first;
  const text = <span className={block.code ? 'tx-quote-code' : undefined}>{shown}</span>;
  const messageId = block.messageId;
  return (
    <div className="tx-quote">
      {reveal && messageId !== null ? (
        <button
          type="button"
          className="tx-quote-text"
          title="Show this passage in the transcript"
          onClick={() => reveal({ messageId, quote: block.text })}
        >
          {text}
        </button>
      ) : (
        <div className="tx-quote-text">{text}</div>
      )}
      {more > 0 ? (
        <button type="button" className="tx-quote-more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Show Less' : `+${more} line${more === 1 ? '' : 's'}`}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Another Claude session wrote to this one. It is an instruction this session
 * acts on, so it reads in full like a prompt -- but under the sender's name,
 * never as "You".
 */
function PeerMessage({ block, msgId }: { block: Extract<UserBlock, { kind: 'agent-message' }>; msgId: string | null }): ReactNode {
  const tasks = useTaskOpener();
  // The sender, found through the message's id (capture/peers.ts). Null until
  // found, and for a sender no open task owns: then the name is plain text.
  const [sender, setSender] = useState<number | null>(null);
  useEffect(() => {
    if (msgId === null) return;
    let live = true;
    void senderTaskOf(msgId)
      .then((id) => {
        if (live) setSender(id);
      })
      .catch(() => {
        /* no link is the fallback */
      });
    return () => {
      live = false;
    };
  }, [msgId]);
  const label = block.name ?? 'another session';
  const target = sender !== null && tasks.has(sender) ? sender : null;
  return (
    <div className="tx-peer">
      <div className="tx-peer-head">
        From{' '}
        {target !== null ? (
          <button type="button" className="tx-peer-name tx-peer-link" title={`Go to ${label}`} onClick={() => tasks.open(target)}>
            {label}
          </button>
        ) : (
          <span className="tx-peer-name">{label}</span>
        )}
      </div>
      <Markdown text={block.text} />
    </div>
  );
}

/** A subagent or background task finishing, in the same language as a tool chip. */
function NotificationChip({ block }: { block: Extract<UserBlock, { kind: 'task-notification' }> }): ReactNode {
  const [open, setOpen] = useState(false);
  const toggle = useActivate(() => setOpen((v) => !v));
  const done = block.status === null || block.status === 'completed';
  const summary = block.summary ?? 'Finished';
  const fields = useMemo(() => block.fields.map((f) => ({ label: f.name, value: f.value })), [block.fields]);

  return (
    <div className={`tx-chip ${done ? 'tx-chip-ok' : 'tx-chip-pending'} ${open ? 'tx-chip-open' : ''}`}>
      <div className="tx-chip-head" onMouseDown={toggle.onMouseDown} onClick={toggle.onClick}>
        <button type="button" className="tx-chip-toggle" aria-expanded={open} aria-label="subagent detail">
          <Disclosure open={open} />
          <span className="tx-chip-name">Subagent</span>
        </button>
        <span className="tx-chip-summary tx-chip-summary-wide">{summary}</span>
        <span className="tx-chip-state">{done ? '✓' : (block.status ?? '…')}</span>
      </div>
      {open ? (
        <div className="tx-chip-body">
          {block.result ? (
            <div className="tx-report">
              <Markdown text={block.result} />
            </div>
          ) : null}
          <FieldList fields={fields} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Something the user started from an Albedo button. Reads as the act -- "Push"
 * -- with the prompt Claude was given folded under it, for when it matters
 * exactly what was asked.
 */
function ActionBlock({ block }: { block: Extract<UserBlock, { kind: 'action' }> }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="tx-action">
      <button
        type="button"
        className="tx-cmd tx-action-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide the prompt Claude was given' : 'Show the prompt Claude was given'}
      >
        <Disclosure open={open} />
        <span className="tx-cmd-name">{block.label}</span>
        <span className="tx-cmd-args">from Albedo</span>
      </button>
      {open ? (
        <div className="tx-think-body">
          <Markdown text={block.text} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A reminder Albedo sent from its card (#156): its own container and label,
 * like the card it came from, so it never reads as something you typed. The
 * brief a replacement task sent with it stays folded.
 */
function ReminderBlock({ block }: { block: Extract<UserBlock, { kind: 'reminder' }> }): ReactNode {
  const who = block.by === 'session' ? 'by Claude' : block.by === 'user' ? 'by you' : null;
  const when = block.setAt !== null ? `set ${dateText(block.setAt, new Date())}` : null;
  const meta = [when, who].filter(Boolean).join(' ');
  return (
    <div className="tx-reminder" role="note" aria-label="Reminder">
      <div className="tx-reminder-head">
        <span className="tx-reminder-tag">
          <ReminderGlyph />
          Reminder
        </span>
        {meta ? <span className="tx-reminder-meta">· {meta}</span> : null}
      </div>
      <Markdown text={block.text} />
      {block.brief ? <Collapsed label="Brief Sent with It" text={block.brief} markdown /> : null}
    </div>
  );
}

/** Past this, only the tail shows until asked: a build's last lines are its verdict. */
const SHELL_TAIL_LINES = 8;
const SHELL_FOLD_AT = 14;

/** Output of a `!` command. stderr after stdout, in its own colour. */
function ShellOutput({ stdout, stderr }: { stdout: string; stderr: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const outLines = stdout.length > 0 ? stdout.split('\n') : [];
  const errLines = stderr.length > 0 ? stderr.split('\n') : [];
  const total = outLines.length + errLines.length;
  const folded = !open && total > SHELL_FOLD_AT;

  // Folded, keep the last lines across both streams, stderr being the later.
  const errShown = folded ? errLines.slice(-SHELL_TAIL_LINES) : errLines;
  const outShown = folded ? outLines.slice(-Math.max(0, SHELL_TAIL_LINES - errShown.length)) : outLines;
  const hidden = total - outShown.length - errShown.length;

  return (
    <div className="tx-shell-out">
      {hidden > 0 ? (
        <button type="button" className="tx-think-head" onClick={() => setOpen(true)} aria-expanded={false}>
          <Disclosure open={false} /> {hidden} Earlier Line{hidden === 1 ? '' : 's'}
        </button>
      ) : open ? (
        <button type="button" className="tx-think-head" onClick={() => setOpen(false)} aria-expanded>
          <Disclosure open /> {total} Lines
        </button>
      ) : null}
      <pre className="tx-pre tx-output">
        {outShown.length > 0 ? <LinkifiedText text={outShown.join('\n')} /> : null}
        {outShown.length > 0 && errShown.length > 0 ? '\n' : null}
        {errShown.length > 0 ? (
          <span className="tx-stderr">
            <LinkifiedText text={errShown.join('\n')} />
          </span>
        ) : null}
      </pre>
    </div>
  );
}

/**
 * De-emphasised and folded away, the way thinking blocks are. `markdown` for
 * a prompt Claude was given, which reads as the action prompt does.
 */
function Collapsed({ label, text, markdown = false }: { label: string; text: string; markdown?: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  if (text.trim().length === 0) return null;
  return (
    <div className="tx-collapsed">
      <button type="button" className="tx-think-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Disclosure open={open} /> {label}
      </button>
      {open ? <div className="tx-think-body">{markdown ? <Markdown text={text} /> : text}</div> : null}
    </div>
  );
}

type SkillText = ReturnType<typeof skillTextOf>;

/**
 * A loaded skill: its name and where it lives, with the SKILL.md folded away.
 * A built-in skill's text names neither, and reads "Skill Loaded" alone.
 */
function SkillBlock({ skill }: { skill: SkillText }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="tx-collapsed">
      <button type="button" className="tx-think-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Disclosure open={open} /> Skill Loaded
        {skill.name ? (
          <>
            {' · '}
            <span className="tx-cmd-name">{skill.name}</span>
          </>
        ) : null}
      </button>
      {open ? (
        <div className="tx-think-body">
          {skill.dir ? <div className="tx-cmd-args">{skill.dir}</div> : null}
          <Markdown text={skill.text} />
        </div>
      ) : null}
    </div>
  );
}

/** A skill's text, whole: every row of the line, each read past a cut. */
function skillTextIn(rows: readonly Message[]): SkillText {
  return skillTextOf(rows.map((m) => fullBodyOf(m) ?? '').join('\n\n'));
}

/**
 * A skill's text on its own (#150): its Skill call is outside the loaded
 * rows, so it cannot fold into that chip. Claude Code wrote it, so the row
 * has no "You", and the text is folded as a typed `/skill` one is.
 */
function SkillTextRow({ message, extras }: { message: Message; extras: readonly Message[] }): ReactNode {
  const skill = useMemo(() => skillTextIn([message, ...extras]), [message, extras]);
  if (skill.text.length === 0) return null;
  return (
    <div className="tx-row tx-row-machine" data-message-id={message.id}>
      <div className="tx-gutter" />
      <div className="tx-content">
        <SkillBlock skill={skill} />
      </div>
    </div>
  );
}

/**
 * The text a Skill call loaded, inside its open chip (#150): where the skill
 * lives, when its text says, and its instructions as markdown.
 */
function SkillInstructions({ rows }: { rows: readonly Message[] }): ReactNode {
  const skill = useMemo(() => skillTextIn(rows), [rows]);
  if (skill.text.length === 0 && skill.dir === null) return null;
  return (
    <section className="tx-chip-section">
      <h4 className="tx-chip-label">Instructions</h4>
      {skill.dir ? <div className="tx-chip-desc">{skill.dir}</div> : null}
      <div className="tx-report">
        <Markdown text={skill.text} />
      </div>
    </section>
  );
}

function AssistantRow({ message }: { message: Message }): ReactNode {
  const text = useMemo(() => fullBodyOf(message) ?? '', [message]);
  return (
    <div className="tx-row tx-row-assistant" data-message-id={message.id}>
      <div className="tx-gutter" />
      <div className="tx-content">
        <Markdown text={text} />
      </div>
    </div>
  );
}

/**
 * An API error Claude Code wrote into the session (#338): "API Error: The
 * response stopped arriving. …". Tinted (--danger-soft, a --danger edge) so it
 * reads as an error and not as Claude's reply. The error the task's last turn
 * stopped on carries Try Again (`ApiErrorRetryContext`); an older one, which
 * more work followed, does not.
 */
function ApiErrorRow({ message }: { message: Message }): ReactNode {
  const retry = useContext(ApiErrorRetryContext);
  const text = apiErrorOf(message.rawJson)?.text || (message.body ?? '');
  const head = /^API Error:\s*/.exec(text);
  return (
    <div className="tx-row tx-row-assistant" data-message-id={message.id}>
      <div className="tx-gutter" />
      <div className="tx-content">
        <div className="tx-api-error" role="note" aria-label="API error">
          <span className="tx-api-error-text">
            {head ? (
              <>
                <b className="tx-api-error-head">API Error:</b> {text.slice(head[0].length)}
              </>
            ) : (
              text
            )}
          </span>
          {retry !== null && retry.messageId === message.id && <TryAgainButton task={retry.task} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Claude Code now usually persists a thinking block as `"thinking": ""` plus a
 * signature: the text was never written to disk. A caret that opens onto
 * nothing is a broken promise, and a "not recorded" line on most turns is noise
 * with nothing to act on, so an empty block renders nothing -- as `Collapsed`,
 * `SystemRow` and `OrphanResultRow` already do. The row (and its raw_json) is
 * still stored; this is only what the pane shows.
 */
function ThinkingRow({ message }: { message: Message }): ReactNode {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => fullBodyOf(message) ?? '', [message]);
  if (text.trim().length === 0) return null;
  const words = text.trim().split(/\s+/).length;
  return (
    <div className="tx-row tx-row-thinking" data-message-id={message.id}>
      <div className="tx-gutter" />
      <div className="tx-content">
        <button type="button" className="tx-think-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Disclosure open={open} /> Thinking · {words} Word{words === 1 ? '' : 's'}
        </button>
        {open ? <div className="tx-think-body">{text}</div> : null}
      </div>
    </div>
  );
}

function SystemRow({ message }: { message: Message }): ReactNode {
  const text = systemRowText(message.body);
  if (text.length === 0) return null;
  return (
    <div className="tx-row tx-row-system" data-message-id={message.id}>
      <div className="tx-gutter">Sys</div>
      <div className="tx-content">
        <div className="tx-system-text">{text}</div>
      </div>
    </div>
  );
}

/**
 * A `/loop` wake-up (#138): Claude Code's "resuming /loop wakeup" line, with
 * the loop's prompt folded under it. Claude Code re-sends that prompt in full
 * on every wake-up, as a `user` line, and writes "[N prior /loop wakeups found
 * nothing actionable…]" before it; both used to read as "You". The note says
 * what the line's "N no-op ticks" already says, so it is dropped. A prompt
 * whose wake-up line is not right before it (the wake-up fired while a turn
 * was still running) is the same row without the line.
 */
function WakeupRow({ message, extras }: { message: Message; extras: readonly Message[] }): ReactNode {
  const rows = [message, ...extras];
  const fire = rows.find((m) => harnessInputOf(m.rawJson) === 'wakeup') ?? null;
  const prompt = rows.find((m) => harnessInputOf(m.rawJson) === 'scheduled-prompt') ?? null;
  const text = fire ? systemRowText(fire.body) : '';
  const promptText = prompt ? (fullBodyOf(prompt) ?? '') : '';
  if (text.length === 0 && promptText.trim().length === 0) return null;
  return (
    <div className="tx-row tx-row-system" data-message-id={message.id}>
      <div className="tx-gutter">Sys</div>
      <div className="tx-content">
        {text.length > 0 ? <div className="tx-system-text">{text}</div> : null}
        <Collapsed label="Scheduled Prompt" text={promptText} markdown />
      </div>
    </div>
  );
}

/**
 * A slash command Claude Code ran itself (`/rc`, `/rename`), which it records
 * as `system` lines: the command, then its output. They read as the user-row
 * versions do -- the command is yours, so it is under "You"; the output is the
 * terminal's, so it has no gutter label. Most output is empty and draws
 * nothing. Before this the command printed as raw tags under "Sys" (#113).
 */
function LocalCommandRow({ message }: { message: Message }): ReactNode {
  const blocks = useMemo(
    () => parseUserBody(message.body ?? '').filter((b) => !(b.kind === 'output' && b.text.length === 0)),
    [message.body],
  );
  if (blocks.length === 0) return null;
  const typed = blocks.some((b) => b.kind === 'command');
  return (
    <div className={`tx-row ${typed ? 'tx-row-user' : 'tx-row-machine'}`} data-message-id={message.id}>
      <div className="tx-gutter">{typed ? 'You' : ''}</div>
      <div className="tx-content">
        {blocks.map((b, i) => (
          <UserBlockView key={i} block={b} />
        ))}
      </div>
    </div>
  );
}

function OrphanResultRow({ message }: { message: Message }): ReactNode {
  const text = toolResultText(message);
  if (text.trim().length === 0) return null;
  return (
    <div className="tx-row tx-row-tool" data-message-id={message.id}>
      <div className="tx-gutter" />
      <div className="tx-content">
        <pre className="tx-pre">
          <LinkifiedText text={text} />
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

function ToolUseRow({
  message,
  result,
  extras,
}: {
  message: Message;
  result: Message | null;
  extras: readonly Message[];
}): ReactNode {
  const rendered = useDiffsFor(message, result);
  const more = extras.length > 0 ? <SkillInstructions rows={extras} /> : null;

  // A mockup shown for approval (#348): a chip per version with how it
  // ended, which opens that version read only.
  if (message.toolName === SHOW_PREVIEW_TOOL) {
    return (
      <div className="tx-row tx-row-tool" data-message-id={message.id}>
        <div className="tx-gutter" />
        <div className="tx-content">
          <PreviewChip message={message} result={result} />
        </div>
      </div>
    );
  }

  // `data-message-id`, as on every row: what the Background band scrolls to,
  // and what a comment on a passage names as its source (#187).
  if (rendered && rendered.diffs.length > 0) {
    return (
      <div className="tx-row tx-row-tool" data-message-id={message.id}>
        <div className="tx-gutter" />
        <div className="tx-content">
          <ToolChip message={message} result={result} more={more} />
          {rendered.diffs.map((d, i) => (
            <CollapsibleDiff key={i} diff={d} expand={rendered.expand[i] ?? null} absoluteLines={rendered.absoluteLines} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="tx-row tx-row-tool" data-message-id={message.id}>
      <div className="tx-gutter" />
      <div className="tx-content">
        <ToolChip message={message} result={result} more={more} />
      </div>
    </div>
  );
}

interface RenderedDiffs {
  diffs: FileDiff[];
  expand: Array<{ oldText: string; newText: string } | null>;
  /**
   * Whether the diffs' line numbers are real file lines. True for `git diff`
   * output and for Write (which produces a whole file starting at line 1);
   * false for Edit/MultiEdit, whose old_string/new_string are fragments.
   */
  absoluteLines: boolean;
}

/** Decide whether this tool call is a diff, and build it if so. */
function useDiffsFor(message: Message, result: Message | null): RenderedDiffs | null {
  const resultText = result ? toolResultText(result) : '';
  return useMemo(() => {
    const tool = message.toolName ?? '';
    const input = toolInput(message);

    if (DIFF_TOOLS.has(tool)) {
      const edit = editPairsOf(message);
      if (edit === null) return null;
      return {
        diffs: edit.pairs.map((p) => diffStrings(p.oldText, p.newText, edit.path)),
        expand: edit.pairs.map((p) => ({ oldText: p.oldText, newText: p.newText })),
        absoluteLines: edit.absoluteLines,
      };
    }

    if (tool === 'Bash') {
      const command = str(input.command) ?? '';
      if (!/\bgit\s+(-[^\s]+\s+)*diff\b/.test(command)) return null;
      if (resultText.length === 0) return null;
      const diffs = parseUnifiedDiff(resultText);
      if (diffs.length === 0) return null;
      return { diffs, expand: diffs.map(() => null), absoluteLines: true };
    }

    return null;
  }, [message, resultText]);
}
