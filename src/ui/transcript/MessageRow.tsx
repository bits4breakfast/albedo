/**
 * One transcript row, rendered according to its `role`.
 *
 * Markdown in assistant text is rendered by a small hand-written subset
 * (paragraphs, fenced code, inline code, lists, quotes, emphasis, links as
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
import Diff, { Code, Disclosure, ExternalLink, LinkifiedText, PathLink, composePieces, useActivate, useCodeTokens } from './Diff';
import { hostOf, safeHttpUrl, splitUrls } from '../../lib/urls';
import { parsePathRef } from '../../lib/paths';
import ToolChip, { FieldList, isObj, str, targetOf, toolInput, toolResultText } from './ToolChip';
import { imageSourceNote, isAllEnvelopes, isImagePlaceholder, parseUserBody, type UserBlock } from './envelopes';
import { imageAt } from '../../capture';

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface MessageRowProps {
  message: Message;
  /** The paired `tool_result` row for a `tool_use`, when it has arrived. */
  result?: Message | null;
  /**
   * For a user row: the rest of the same message -- an attached image, the
   * note naming its file -- so it renders as one band. See groupRows.
   */
  extras?: readonly Message[];
}

export function MessageRow({ message, result = null, extras = [] }: MessageRowProps): ReactNode {
  switch (message.role) {
    case 'user':
      return <UserRow message={message} extras={extras} />;
    case 'assistant':
      return message.toolName === 'thinking' ? <ThinkingRow message={message} /> : <AssistantRow message={message} />;
    case 'system':
      return <SystemRow message={message} />;
    case 'tool_use':
      return <ToolUseRow message={message} result={result} />;
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
    const out: UserPart[] = [];
    for (const m of [message, ...extras]) {
      const body = m.body ?? '';
      if (isImagePlaceholder(body)) {
        out.push({ kind: 'image', src: imageAt(m.rawJson, m.seq)?.src ?? null });
        continue;
      }
      const source = imageSourceNote(body);
      if (source !== null) {
        out.push({ kind: 'source', path: source });
        continue;
      }
      const blocks = parseUserBody(body);
      if (blocks.length > 0) out.push({ kind: 'blocks', blocks });
    }
    return out;
  }, [message, extras]);

  if (parts.length === 0) return null;
  // Nothing a human typed or attached: drop the "you said" framing rather than
  // attributing a harness notification to the user.
  const machine = parts.every((p) => p.kind === 'blocks' && isAllEnvelopes(p.blocks));
  return (
    <div className={`tx-row ${machine ? 'tx-row-machine' : 'tx-row-user'}`}>
      <div className="tx-gutter">{machine ? '' : 'you'}</div>
      <div className="tx-content">
        {parts.map((p, i) =>
          p.kind === 'blocks' ? (
            p.blocks.map((b, j) => <UserBlockView key={`${i}-${j}`} block={b} />)
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

  if (src === null) return <div className="tx-img-missing">image (not stored in the transcript)</div>;
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

function UserBlockView({ block }: { block: UserBlock }): ReactNode {
  switch (block.kind) {
    case 'text':
      return <Markdown text={block.text} />;
    case 'task-notification':
      return <NotificationChip block={block} />;
    case 'command':
      return (
        <div className="tx-cmd">
          <span className="tx-cmd-name">{block.name}</span>
          {block.args ? <span className="tx-cmd-args">{block.args}</span> : null}
        </div>
      );
    case 'system-reminder':
      return <Collapsed label="injected context" text={block.text} />;
    case 'skill':
      return <SkillBlock block={block} />;
    case 'pasted': {
      const lines = block.text.split('\n').length;
      return <Collapsed label={`pasted text · ${lines} line${lines === 1 ? '' : 's'}`} text={block.text} />;
    }
    case 'output':
      return (
        <pre className="tx-pre tx-output">
          <LinkifiedText text={block.text} />
        </pre>
      );
    default:
      return null;
  }
}

/** A subagent or background task finishing, in the same language as a tool chip. */
function NotificationChip({ block }: { block: Extract<UserBlock, { kind: 'task-notification' }> }): ReactNode {
  const [open, setOpen] = useState(false);
  const toggle = useActivate(() => setOpen((v) => !v));
  const done = block.status === null || block.status === 'completed';
  const summary = block.summary ?? 'finished';
  const fields = useMemo(() => block.fields.map((f) => ({ label: f.name, value: f.value })), [block.fields]);

  return (
    <div className={`tx-chip ${done ? 'tx-chip-ok' : 'tx-chip-pending'} ${open ? 'tx-chip-open' : ''}`}>
      <div className="tx-chip-head" onMouseDown={toggle.onMouseDown} onClick={toggle.onClick}>
        <button type="button" className="tx-chip-toggle" aria-expanded={open} aria-label="subagent detail">
          <Disclosure open={open} />
          <span className="tx-chip-name">subagent</span>
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

/** De-emphasised and folded away, the way thinking blocks are. */
function Collapsed({ label, text }: { label: string; text: string }): ReactNode {
  const [open, setOpen] = useState(false);
  if (text.trim().length === 0) return null;
  return (
    <div className="tx-collapsed">
      <button type="button" className="tx-think-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Disclosure open={open} /> {label}
      </button>
      {open ? <div className="tx-think-body">{text}</div> : null}
    </div>
  );
}

/** A loaded skill: its name and where it lives, with the SKILL.md folded away. */
function SkillBlock({ block }: { block: Extract<UserBlock, { kind: 'skill' }> }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="tx-collapsed">
      <button type="button" className="tx-think-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Disclosure open={open} /> skill loaded · <span className="tx-cmd-name">{block.name}</span>
      </button>
      {open ? (
        <div className="tx-think-body">
          <div className="tx-cmd-args">{block.dir}</div>
          <Markdown text={block.text} />
        </div>
      ) : null}
    </div>
  );
}

function AssistantRow({ message }: { message: Message }): ReactNode {
  return (
    <div className="tx-row tx-row-assistant">
      <div className="tx-gutter" />
      <div className="tx-content">
        <Markdown text={message.body ?? ''} />
      </div>
    </div>
  );
}

function ThinkingRow({ message }: { message: Message }): ReactNode {
  const [open, setOpen] = useState(false);
  const text = message.body ?? '';
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  return (
    <div className="tx-row tx-row-thinking">
      <div className="tx-gutter" />
      <div className="tx-content">
        <button type="button" className="tx-think-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Disclosure open={open} /> thinking{words > 0 ? ` · ${words} words` : ''}
        </button>
        {open ? <div className="tx-think-body">{text}</div> : null}
      </div>
    </div>
  );
}

function SystemRow({ message }: { message: Message }): ReactNode {
  const text = (message.body ?? '').trim();
  if (text.length === 0) return null;
  return (
    <div className="tx-row tx-row-system">
      <div className="tx-gutter">sys</div>
      <div className="tx-content">
        <div className="tx-system-text">{text}</div>
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

function ToolUseRow({ message, result }: { message: Message; result: Message | null }): ReactNode {
  const rendered = useDiffsFor(message, result);

  if (rendered && rendered.diffs.length > 0) {
    return (
      <div className="tx-row tx-row-tool">
        <div className="tx-gutter" />
        <div className="tx-content">
          <ToolChip message={message} result={result} />
          {rendered.diffs.map((d, i) => (
            <Diff key={i} diff={d} expand={rendered.expand[i] ?? null} absoluteLines={rendered.absoluteLines} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="tx-row tx-row-tool">
      <div className="tx-gutter" />
      <div className="tx-content">
        <ToolChip message={message} result={result} />
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
  | { t: 'list'; ordered: boolean; items: string[] }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | { t: 'table'; align: Align[]; head: string[]; rows: string[][] };

type Align = 'left' | 'center' | 'right' | null;

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

    const item = ITEM_RE.exec(line);
    if (item) {
      const ordered = item[2] === undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        const m = ITEM_RE.exec(l);
        if (m) {
          items.push(m[4] ?? '');
          i++;
          continue;
        }
        // Continuation of the previous item: indented, non-empty, not a new block.
        if (l.trim() !== '' && /^\s{2,}/.test(l) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1] ?? ''}\n${l.trim()}`;
          i++;
          continue;
        }
        break;
      }
      out.push({ t: 'list', ordered, items });
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
 */
function codeSpanRef(text: string): { path: string; line: number | null } | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
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

/** Inline markdown to React nodes. Never produces raw HTML. */
export function parseInline(text: string, depth = 0): ReactNode[] {
  if (depth > 3) return [text];
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE_RE.source, 'gu');
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  /** Plain text between markup, with any web URL in it made a link. */
  const pushPlain = (chunk: string): void => {
    for (const part of splitUrls(chunk)) {
      if (typeof part === 'string') out.push(part);
      else out.push(<ExternalLink key={key++} url={part.url} />);
    }
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
          <PathLink key={key++} path={ref.path} line={ref.line} className="tx-md-code tx-md-code-link">
            {codeText}
          </PathLink>
        ) : (
          <code key={key++} className="tx-md-code">
            {codeText}
          </code>
        ),
      );
    } else if (strongA !== undefined || strongB !== undefined) {
      out.push(<strong key={key++}>{parseInline(strongA ?? strongB ?? '', depth + 1)}</strong>);
    } else if (emA !== undefined || emB !== undefined) {
      out.push(<em key={key++}>{parseInline(emA ?? emB ?? '', depth + 1)}</em>);
    } else if (strike !== undefined) {
      out.push(<s key={key++}>{parseInline(strike, depth + 1)}</s>);
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

export function Markdown({ text }: { text: string }): ReactNode {
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
                {parseInline(b.text)}
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
                          {parseInline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, j) => (
                          <td key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                            {parseInline(cell)}
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
                {parseInline(b.text)}
              </blockquote>
            );
          case 'list':
            return b.ordered ? (
              <ol key={i} className="tx-md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{parseInline(it)}</li>
                ))}
              </ol>
            ) : (
              <ul key={i} className="tx-md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{parseInline(it)}</li>
                ))}
              </ul>
            );
          case 'p':
          default:
            return (
              <p key={i} className="tx-md-p">
                {parseInline(b.text)}
              </p>
            );
        }
      })}
    </div>
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
