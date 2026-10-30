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

import { memo, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { FileDiff, Message } from '../../types';
import { diffStrings, langForPath, parseUnifiedDiff } from '../../lib/diff';
import { CollapsibleDiff, Code, Disclosure, ExternalLink, LinkifiedText, PathLink, composePieces, useActivate, useCodeTokens } from './Diff';
import { hostOf, safeHttpUrl, splitUrls } from '../../lib/urls';
import { bareFileRef, parsePathRef } from '../../lib/paths';
import { lineCount } from './pastedText';
import ToolChip, { FieldList, isObj, str, targetOf, toolInput, toolResultText } from './ToolChip';
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
import { MentionChip } from './MentionChip';
import type { Mention } from './mentions';

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

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
      return message.toolName === 'thinking' ? <ThinkingRow message={message} /> : <AssistantRow message={message} />;
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
    <div className={`tx-row ${machine ? 'tx-row-machine' : 'tx-row-user'}`}>
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
    <div className="tx-row tx-row-machine">
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
    <div className="tx-row tx-row-assistant">
      <div className="tx-gutter" />
      <div className="tx-content">
        <Markdown text={text} />
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
    <div className="tx-row tx-row-thinking">
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
    <div className="tx-row tx-row-system">
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
    <div className="tx-row tx-row-system">
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
    <div className={`tx-row ${typed ? 'tx-row-user' : 'tx-row-machine'}`}>
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
    <div className="tx-row tx-row-tool">
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

  // `data-message-id`: what the Background band scrolls to.
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
      const path = targetOf(message) ?? 'file';
      const diffs: FileDiff[] = [];
      const expand: Array<{ oldText: string; newText: string } | null> = [];

      if (tool === 'Write') {
        const content = str(input.content);
        if (content === null) return null;
        diffs.push(diffStrings('', content, path));
        expand.push({ oldText: '', newText: content });
      } else if (tool === 'MultiEdit') {
        const edits = Array.isArray(input.edits) ? input.edits : [];
        for (const edit of edits) {
          if (!isObj(edit)) continue;
          const oldText = str(edit.old_string);
          const newText = str(edit.new_string);
          if (oldText === null || newText === null) continue;
          diffs.push(diffStrings(oldText, newText, path));
          expand.push({ oldText, newText });
        }
      } else {
        const oldText = str(input.old_string) ?? str(input.old_source);
        const newText = str(input.new_string) ?? str(input.new_source);
        if (oldText === null || newText === null) return null;
        diffs.push(diffStrings(oldText, newText, path));
        expand.push({ oldText, newText });
      }
      return diffs.length > 0 ? { diffs, expand, absoluteLines: tool === 'Write' } : null;
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

// ---------------------------------------------------------------------------
// Markdown subset
// ---------------------------------------------------------------------------

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; code: string }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | { t: 'table'; align: Align[]; head: string[]; rows: string[][] };

type Align = 'left' | 'center' | 'right' | null;

/** One list item: its own text, then any blocks nested under it (sub-lists). */
interface ListItem {
  text: string;
  children: Block[];
}

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const ITEM_RE = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
/** A GFM delimiter row: `|---|:--:|`, outer pipes optional. */
const DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * A table row's cells, GFM style: outer pipes optional, `\|` is a literal
 * pipe, and a pipe inside a code span does not split.
 */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  const cells: string[] = [];
  let cell = '';
  let tick = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '\\' && s[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      cell += '`'.repeat(run);
      i += run - 1;
      tick = tick === 0 ? run : tick === run ? 0 : tick;
    } else if (c === '|' && tick === 0) {
      cells.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  // A trailing pipe closes the last cell rather than opening an empty one.
  if (cell.trim() !== '' || !s.trimEnd().endsWith('|')) cells.push(cell.trim());
  return cells;
}

/** Whether `lines[i]` opens a table: a header row followed by its delimiter row. */
function tableStartsAt(lines: readonly string[], i: number): boolean {
  const head = lines[i] ?? '';
  const delim = lines[i + 1] ?? '';
  if (!head.includes('|') || !DELIM_RE.test(delim)) return false;
  return splitRow(head).length === splitRow(delim).length;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

/** Width of leading whitespace in columns, a tab advancing to the next multiple of 4. */
function columns(ws: string): number {
  let col = 0;
  for (const c of ws) col = c === '\t' ? col + 4 - (col % 4) : col + 1;
  return col;
}

interface ItemLine {
  /** Columns before the marker. */
  indent: number;
  ordered: boolean;
  num: number;
  text: string;
}

function itemAt(line: string): ItemLine | null {
  const m = ITEM_RE.exec(line);
  if (!m) return null;
  const indent = columns(m[1] ?? '');
  return { indent, ordered: m[2] === undefined, num: Number(m[3] ?? 1), text: m[4] ?? '' };
}

/**
 * One list starting at `lines[i]`, nested lists included, as a tree.
 *
 * Nesting is relative to marker indents, not CommonMark's content column:
 * a transcript viewer should show what the author meant, and `1. a` followed
 * by `  - b` (2 spaces) is meant as a sub-list -- Claude Code's terminal
 * renders it nested -- though CommonMark makes it a separate list. So the
 * list records its first item's indent as `base`. An item indented further
 * than the last item's marker opens a nested list under that item (any step:
 * 1, 2, 3 or 4 spaces); one at `base` or beyond, but not further than the
 * last item's marker, is a sibling; one left of `base` belongs to an outer
 * list. `floor` is the parent item's marker indent + 1 (0 at the top level).
 * A marker of the other kind (bullet vs number) at this level ends the list,
 * as in CommonMark. A blank
 * line ends it unless the next non-blank line is an item this list or one
 * of its sub-lists takes (a loose list). Continuation lines -- non-blank,
 * not an item, indented 2+ -- join the deepest open item, as before nesting
 * existed; that includes an indented code fence, which stays item text.
 *
 * Returns the list and the index of the first line it did not take.
 */
function parseList(lines: readonly string[], i: number, floor: number): [Block, number] {
  const first = itemAt(lines[i] ?? '');
  const ordered = first?.ordered ?? false;
  const start = first?.num ?? 1;
  const base = first?.indent ?? 0;
  const items: ListItem[] = [];
  let last = 0; // the last item's marker indent

  while (i < lines.length) {
    const l = lines[i] ?? '';
    if (l.trim() === '') {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      const after = itemAt(lines[j] ?? '');
      if (after && after.indent >= floor && items.length > 0) {
        i = j;
        continue;
      }
      break;
    }
    const it = itemAt(l);
    if (it) {
      if (items.length > 0 && it.indent > last) {
        const [sub, next] = parseList(lines, i, last + 1);
        items[items.length - 1]?.children.push(sub);
        i = next;
        continue;
      }
      if (it.indent < base || (items.length > 0 && it.ordered !== ordered)) break;
      items.push({ text: it.text, children: [] });
      last = it.indent;
      i++;
      continue;
    }
    if (/^\s{2,}/.test(l) && items.length > 0) {
      const open = items[items.length - 1] as ListItem;
      open.text = `${open.text}\n${l.trim()}`;
      i++;
      continue;
    }
    break;
  }

  return [{ t: 'list', ordered, start, items }, i];
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const lang = (fence[2] ?? '').trim();
      i++;
      const buf: string[] = [];
      let closed = false;
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (l.trim().startsWith(marker)) {
          i++;
          closed = true;
          break;
        }
        buf.push(l);
        i++;
      }
      void closed; // an unclosed fence still renders as code, which is what the author meant
      out.push({ t: 'code', lang, code: buf.join('\n') });
      continue;
    }

    // Before HR: a delimiter row like `---|---` must never read as a rule.
    if (tableStartsAt(lines, i)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1] ?? '').map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (l.trim() === '' || !l.includes('|')) break;
        // Short rows are padded and long ones cut, so every row has the header's width.
        const cells = splitRow(l).slice(0, head.length);
        while (cells.length < head.length) cells.push('');
        rows.push(cells);
        i++;
      }
      out.push({ t: 'table', align, head, rows });
      continue;
    }

    if (HR_RE.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      out.push({ t: 'h', level: (heading[1] ?? '#').length, text: heading[2] ?? '' });
      i++;
      continue;
    }

    if (line.trimStart().startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (!l.trimStart().startsWith('>')) break;
        buf.push(l.trimStart().replace(/^>\s?/, ''));
        i++;
      }
      out.push({ t: 'quote', text: buf.join('\n') });
      continue;
    }

    if (ITEM_RE.test(line)) {
      const [list, next] = parseList(lines, i, 0);
      out.push(list);
      i = next;
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (l.trim() === '') break;
      if (FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || ITEM_RE.test(l)) break;
      if (l.trimStart().startsWith('>')) break;
      // A table may start straight after a paragraph line, as on GitHub.
      if (tableStartsAt(lines, i)) break;
      buf.push(l);
      i++;
    }
    if (buf.length === 0) i++;
    else out.push({ t: 'p', text: buf.join('\n') });
  }

  return out;
}

/**
 * Decide whether an inline code span is a path reference.
 *
 * Deliberately strict: only when the span is *nothing but* the reference. A
 * span like `npm run build` may well contain something path-shaped, and
 * turning that into a link makes the pane feel unreliable -- a false positive
 * costs more than a missed link. Extraction itself stays in `parsePathRef`.
 *
 * Two shapes a code span has and prose does not:
 *  - a line range, `src/a.php:64-75`, which opens at its first line;
 *  - a bare file name, `Foo.php` or `Foo.php:12` (`bareFileRef`), which the
 *    shell looks up in the worktree when clicked.
 */
export function codeSpanRef(text: string): { path: string; line: number | null; bare?: boolean } | null {
  const range = /^(.*:\d{1,7})-\d{1,7}$/.exec(text.trim());
  const trimmed = range ? (range[1] ?? '') : text.trim();
  if (trimmed.length === 0) return null;
  const bare = bareFileRef(trimmed);
  if (bare) return { ...bare, bare: true };
  let ref: { path: string; line: number | null } | null = null;
  try {
    ref = parsePathRef(trimmed);
  } catch {
    return null;
  }
  if (!ref || ref.path.length === 0 || !trimmed.startsWith(ref.path)) return null;
  const rest = trimmed.slice(ref.path.length);
  if (rest.length > 0 && !/^:\d+(?::\d+)?$/.test(rest)) return null;
  return ref;
}

const INLINE_RE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|(?<![\p{L}\p{N}_])__([\s\S]+?)__(?![\p{L}\p{N}_])|\*([^*\n]+?)\*|(?<![\p{L}\p{N}_])_([^_\n]+?)_(?![\p{L}\p{N}_])|~~([\s\S]+?)~~|\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/gu;

/**
 * Where each reference's label (`@Fix login retry`, `@src/foo.ts`) stands in
 * a run of plain text: on its own, as `bareFileMentions` and the composer's
 * tokens require. Longest label first, so `@a.tsx` is not cut at `@a.ts`.
 */
function mentionRe(mentions: readonly Mention[]): RegExp | null {
  if (mentions.length === 0) return null;
  const labels = [...new Set(mentions.map((m) => m.label))].sort((a, b) => b.length - a.length);
  const alt = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<=^|[\\s(\\["'])(?:${alt})(?=$|[\\s.,;:!?)\\]}'"])`, 'g');
}

/**
 * Inline markdown to React nodes. Never produces raw HTML. `mentions`: the
 * references in a message you wrote (#154), drawn as chips where their label
 * stands in plain text -- never inside code.
 */
export function parseInline(text: string, depth = 0, mentions: readonly Mention[] = []): ReactNode[] {
  if (depth > 3) return [text];
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE_RE.source, 'gu');
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  /** Plain text between markup, with any web URL in it made a link. */
  const pushUrls = (chunk: string): void => {
    for (const part of splitUrls(chunk)) {
      if (typeof part === 'string') out.push(part);
      else out.push(<ExternalLink key={key++} url={part.url} />);
    }
  };
  const refs = mentionRe(mentions);
  /** ...and each reference's label a chip. */
  const pushPlain = (chunk: string): void => {
    if (refs === null || !chunk.includes('@')) {
      pushUrls(chunk);
      return;
    }
    let at = 0;
    for (const m of chunk.matchAll(refs)) {
      const mention = mentions.find((x) => x.label === m[0]);
      if (!mention) continue;
      if (m.index > at) pushUrls(chunk.slice(at, m.index));
      out.push(<MentionChip key={key++} mention={mention} />);
      at = m.index + m[0].length;
    }
    if (at < chunk.length) pushUrls(chunk.slice(at));
  };

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) pushPlain(text.slice(last, m.index));
    const [, , codeText, strongA, strongB, emA, emB, strike, linkText, linkUrl] = m;

    if (codeText !== undefined) {
      const ref = codeSpanRef(codeText);
      const asUrl = safeHttpUrl(codeText);
      out.push(
        asUrl !== null && /^https?:\/\//i.test(codeText.trim()) ? (
          <ExternalLink key={key++} url={asUrl} className="tx-md-code">
            {codeText}
          </ExternalLink>
        ) : ref ? (
          <PathLink key={key++} path={ref.path} line={ref.line} lookup={ref.bare === true} className="tx-md-code tx-md-code-link">
            {codeText}
          </PathLink>
        ) : (
          <code key={key++} className="tx-md-code">
            {codeText}
          </code>
        ),
      );
    } else if (strongA !== undefined || strongB !== undefined) {
      out.push(<strong key={key++}>{parseInline(strongA ?? strongB ?? '', depth + 1, mentions)}</strong>);
    } else if (emA !== undefined || emB !== undefined) {
      out.push(<em key={key++}>{parseInline(emA ?? emB ?? '', depth + 1, mentions)}</em>);
    } else if (strike !== undefined) {
      out.push(<s key={key++}>{parseInline(strike, depth + 1, mentions)}</s>);
    } else if (linkText !== undefined) {
      const target = linkUrl ? safeHttpUrl(linkUrl) : null;
      const label = linkText.length > 0 ? linkText : (linkUrl ?? '');
      if (target === null) {
        // Not a web link (relative, `file:`, `javascript:` ...): shown, not clickable.
        out.push(
          <span key={key++} className="tx-md-link" title={linkUrl ?? ''}>
            {label}
          </span>,
        );
      } else {
        // The label is the model's; the host is the truth. When they differ the
        // host is shown beside it, so a label cannot disguise the destination.
        const host = hostOf(target);
        const labelIsUrl = /^https?:\/\//i.test(label.trim());
        out.push(
          <ExternalLink key={key++} url={target} className="tx-md-link">
            {label}
            {host && !labelIsUrl ? <span className="tx-url-host"> ({host})</span> : null}
          </ExternalLink>,
        );
      }
    } else {
      out.push(m[0]);
    }
    last = m.index + m[0].length;
  }

  if (last < text.length) pushPlain(text.slice(last));
  return out;
}

const NO_MENTIONS: readonly Mention[] = [];

export function Markdown({ text, mentions = NO_MENTIONS }: { text: string; mentions?: readonly Mention[] }): ReactNode {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  if (text.trim().length === 0) return null;
  return (
    <div className="tx-md">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'code':
            return <CodeBlock key={i} code={b.code} lang={b.lang} />;
          case 'h': {
            const level = Math.min(4, Math.max(1, b.level));
            return (
              <div key={i} className={`tx-md-h tx-md-h${level}`}>
                {parseInline(b.text, 0, mentions)}
              </div>
            );
          }
          case 'hr':
            return <div key={i} className="tx-md-hr" />;
          case 'table':
            return (
              // The wrapper scrolls sideways, so a wide table never widens the pane.
              <div key={i} className="tx-md-table-wrap">
                <table className="tx-md-table">
                  <thead>
                    <tr>
                      {b.head.map((cell, j) => (
                        <th key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                          {parseInline(cell, 0, mentions)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, j) => (
                          <td key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                            {parseInline(cell, 0, mentions)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'quote':
            return (
              <blockquote key={i} className="tx-md-quote">
                {parseInline(b.text, 0, mentions)}
              </blockquote>
            );
          case 'list':
            return <MdList key={i} list={b} mentions={mentions} />;
          case 'p':
          default:
            return (
              <p key={i} className="tx-md-p">
                {parseInline(b.text, 0, mentions)}
              </p>
            );
        }
      })}
    </div>
  );
}

/** A list and, inside each item, the lists nested under it. */
function MdList({ list, mentions }: { list: Extract<Block, { t: 'list' }>; mentions: readonly Mention[] }): ReactNode {
  const items = list.items.map((it, j) => (
    <li key={j}>
      {parseInline(it.text, 0, mentions)}
      {it.children.map((c, k) => (c.t === 'list' ? <MdList key={k} list={c} mentions={mentions} /> : null))}
    </li>
  ));
  return list.ordered ? (
    <ol className="tx-md-list" start={list.start === 1 ? undefined : list.start}>
      {items}
    </ol>
  ) : (
    <ul className="tx-md-list">{items}</ul>
  );
}

const CODE_LANG_ALIAS: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  golang: 'go',
};

function CodeBlock({ code, lang }: { code: string; lang: string }): ReactNode {
  const resolved = useMemo(() => {
    const key = lang.toLowerCase();
    if (key.length === 0) return 'text';
    return CODE_LANG_ALIAS[key] ?? (key.includes('.') ? langForPath(key) : key);
  }, [lang]);
  const tokens = useCodeTokens(code, resolved);
  const lines = useMemo(() => code.split('\n'), [code]);

  return (
    <div className="tx-md-pre">
      {lang ? <div className="tx-md-pre-lang">{lang}</div> : null}
      <pre className="tx-pre tx-pre-code">
        {lines.map((line, i) => (
          <div className="tx-md-pre-line" key={i}>
            <Code pieces={composePieces(line, tokens[i], undefined)} />
          </div>
        ))}
      </pre>
    </div>
  );
}
