/**
 * A tool call, collapsed to one line by default.
 *
 * The chip carries the four things you scan for -- tool, target, outcome, and a
 * one-glance summary of what it did -- and hides the rest behind a click. This
 * module also owns the `rawJson` narrowing helpers, because every renderer in
 * the pane needs them and they must stay in one place.
 *
 * `rawJson` is the verbatim JSONL object for the row. The adapter may hand us
 * either the whole transcript line or the individual content block, so every
 * accessor below tries both shapes and returns a safe empty value rather than
 * assuming a key exists.
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Message } from '../../types';
import { CodeLines, Disclosure, LinkifiedText, PathLink, useActivate } from './Diff';
import { inputViewFor, type InputField, type InputView } from './toolViews';

// ---------------------------------------------------------------------------
// rawJson narrowing
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseRaw(raw: string | null | undefined): Obj | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** Content blocks of a transcript line, if `raw` is a whole line. */
function contentBlocks(raw: Obj | null): unknown[] {
  if (!raw) return [];
  const msg = raw.message;
  if (isObj(msg) && Array.isArray(msg.content)) return msg.content;
  if (Array.isArray(raw.content)) return raw.content;
  return [];
}

/**
 * `seq` is `lineIndex * 100 + blockIndex` (see docs/TRANSCRIPT-FORMAT.md), so
 * the low two digits identify which block of the line this row came from. That
 * is the only way to disambiguate a line carrying two calls to the same tool.
 */
function blockFor(message: Message, type: 'tool_use' | 'tool_result'): Obj | null {
  const raw = parseRaw(message.rawJson);
  if (!raw) return null;
  if (raw.type === type) return raw;

  const blocks = contentBlocks(raw);
  const idx = message.seq % 100;
  const byIndex = blocks[idx];
  if (isObj(byIndex) && byIndex.type === type) {
    if (type === 'tool_result' || message.toolName === null || byIndex.name === message.toolName) return byIndex;
  }
  const matching = blocks.filter((b): b is Obj => isObj(b) && b.type === type);
  const byName = message.toolName ? matching.find((b) => b.name === message.toolName) : undefined;
  return byName ?? matching[0] ?? null;
}

/** Input object of a `tool_use` row. Always an object, possibly empty. */
export function toolInput(message: Message): Obj {
  const block = blockFor(message, 'tool_use');
  if (block && isObj(block.input)) return block.input;
  const raw = parseRaw(message.rawJson);
  if (raw && isObj(raw.input)) return raw.input;
  return {};
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function flattenContent(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((b) => (isObj(b) ? (str(b.text) ?? str(b.content) ?? '') : typeof b === 'string' ? b : ''))
      .filter((s) => s.length > 0)
      .join('\n');
  }
  if (isObj(v)) {
    const stdout = str(v.stdout);
    const stderr = str(v.stderr);
    if (stdout !== null || stderr !== null) return [stdout, stderr].filter((s) => s && s.length > 0).join('\n');
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

/** Best-effort plain text of a `tool_result` row. */
export function toolResultText(message: Message | null | undefined): string {
  if (!message) return '';
  const block = blockFor(message, 'tool_result');
  if (block) {
    const text = flattenContent(block.content);
    if (text.length > 0) return text;
  }
  const raw = parseRaw(message.rawJson);
  if (raw) {
    const text = flattenContent(raw.toolUseResult);
    if (text.length > 0) return text;
  }
  return message.body ?? '';
}

/** True when the result reported failure. */
export function toolResultIsError(message: Message | null | undefined): boolean {
  if (!message) return false;
  const block = blockFor(message, 'tool_result');
  if (block && block.is_error === true) return true;
  const raw = parseRaw(message.rawJson);
  if (raw) {
    if (raw.is_error === true) return true;
    if (raw.toolDenialKind !== undefined && raw.toolDenialKind !== null) return true;
    const tur = raw.toolUseResult;
    if (isObj(tur) && tur.interrupted === true) return true;
  }
  return false;
}

/** `tool_use_id` linking a result row back to its call, from either shape. */
export function toolUseId(message: Message): string | null {
  const raw = parseRaw(message.rawJson);
  if (!raw) return null;
  if (message.role === 'tool_use') {
    const block = blockFor(message, 'tool_use');
    return str(block?.id) ?? str(raw.id);
  }
  const block = blockFor(message, 'tool_result');
  return str(block?.tool_use_id) ?? str(raw.tool_use_id);
}

export function isSidechain(message: Message): boolean {
  return parseRaw(message.rawJson)?.isSidechain === true;
}

// ---------------------------------------------------------------------------
// Chip summary
// ---------------------------------------------------------------------------

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function targetOf(message: Message): string | null {
  if (message.targetPath) return message.targetPath;
  const input = toolInput(message);
  return str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? null;
}

function firstLine(s: string, max = 140): string {
  const line = s.split('\n', 1)[0] ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** The compact, tool-specific detail shown on the collapsed chip. */
export function summaryOf(message: Message): string | null {
  const input = toolInput(message);
  switch (message.toolName) {
    case 'Bash':
    case 'BashOutput': {
      return firstLine(str(input.command) ?? str(input.description) ?? '');
    }
    case 'Read': {
      const offset = typeof input.offset === 'number' ? input.offset : null;
      const limit = typeof input.limit === 'number' ? input.limit : null;
      if (offset !== null && limit !== null) return `lines ${offset}–${offset + limit}`;
      if (offset !== null) return `from line ${offset}`;
      if (limit !== null) return `first ${limit} lines`;
      return null;
    }
    case 'Grep': {
      const pattern = str(input.pattern);
      const glob = str(input.glob) ?? str(input.path);
      if (!pattern) return null;
      return glob ? `/${pattern}/ in ${glob}` : `/${pattern}/`;
    }
    case 'Glob':
      return str(input.pattern);
    case 'WebFetch':
    case 'WebSearch':
      return firstLine(str(input.url) ?? str(input.query) ?? '');
    case 'Task':
      return firstLine(str(input.description) ?? str(input.subagent_type) ?? '');
    case 'TodoWrite': {
      const todos = input.todos;
      return Array.isArray(todos) ? `${todos.length} items` : null;
    }
    case 'Write': {
      const content = str(input.content);
      return content === null ? null : `${content.split('\n').length} lines`;
    }
    default: {
      const command = str(input.command);
      if (command) return firstLine(command);
      const desc = str(input.description) ?? str(input.prompt);
      return desc ? firstLine(desc) : null;
    }
  }
}

function pretty(input: Obj): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ToolChipProps {
  message: Message;
  /** The paired `tool_result` row, when one has arrived. */
  result?: Message | null;
  defaultOpen?: boolean;
}

export function ToolChip({ message, result = null, defaultOpen = false }: ToolChipProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const [raw, setRaw] = useState(false);

  const name = message.toolName ?? 'tool';
  const target = targetOf(message);
  const summary = summaryOf(message);
  const error = toolResultIsError(result);
  const pending = result === null;
  const resultText = open ? toolResultText(result) : '';
  const input = toolInput(message);

  const state = pending ? 'pending' : error ? 'error' : 'ok';
  const inputView = useMemo(() => inputViewFor(message.toolName, input), [message.toolName, input]);
  // Same drag/selection guard the links use, so toggling the chip does not
  // fire at the end of a drag-select over the row.
  const toggle = useActivate(() => setOpen((v) => !v));

  return (
    <div className={`tx-chip tx-chip-${state} ${open ? 'tx-chip-open' : ''}`}>
      {/*
        The head is a row, not a button: the target path inside it is a link of
        its own, and nesting interactive elements inside a button is both
        invalid and ambiguous to click. The caret button carries the keyboard
        affordance; clicking anywhere else in the row toggles too, except on the
        path, which stops propagation and opens the file instead.
      */}
      <div className="tx-chip-head" onMouseDown={toggle.onMouseDown} onClick={toggle.onClick}>
        <button type="button" className="tx-chip-toggle" aria-expanded={open} aria-label={`${name} details`}>
          <Disclosure open={open} />
          <span className="tx-chip-name">{name}</span>
        </button>
        {target ? (
          <PathLink path={target} className="tx-chip-target" title={target}>
            {basename(target)}
          </PathLink>
        ) : null}
        {summary ? <span className="tx-chip-summary">{summary}</span> : null}
        <span className="tx-chip-state" title={state}>
          {pending ? '…' : error ? '✕' : '✓'}
        </span>
      </div>

      {open ? (
        <div className="tx-chip-body">
          {target ? (
            <div className="tx-chip-path">
              <PathLink path={target} />
            </div>
          ) : null}
          {Object.keys(input).length > 0 ? (
            <section className="tx-chip-section">
              <h4 className="tx-chip-label">
                input
                {inputView.kind !== 'json' ? (
                  <button type="button" className="tx-chip-raw" onClick={() => setRaw((v) => !v)}>
                    {raw ? 'formatted' : 'raw'}
                  </button>
                ) : null}
              </h4>
              {/*
                Formatting input is a readability choice, so it is never the
                only one: the raw JSON stays one click away, because what was
                actually sent occasionally matters more than how it reads.
              */}
              {raw || inputView.kind === 'json' ? (
                <pre className="tx-pre">{pretty(input)}</pre>
              ) : (
                <ToolInput view={inputView} />
              )}
            </section>
          ) : null}
          <section className="tx-chip-section">
            <h4 className="tx-chip-label">{error ? 'error' : 'result'}</h4>
            {pending ? (
              <div className="tx-chip-empty">no result yet</div>
            ) : resultText.length === 0 ? (
              <div className="tx-chip-empty">empty</div>
            ) : (
              // Stack traces and compiler errors live here; this is where a
              // clickable path pays off most.
              <pre className={`tx-pre ${error ? 'tx-pre-error' : ''}`}>
                <LinkifiedText text={resultText} />
              </pre>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

/** Renders whatever shape `toolViews` decided this tool's input should take. */
function ToolInput({ view }: { view: InputView }): ReactNode {
  switch (view.kind) {
    case 'shell':
      return (
        <>
          {view.description ? <div className="tx-chip-desc">{view.description}</div> : null}
          <CodeLines code={view.command} lang="shellscript" />
          <FieldList fields={view.fields} />
        </>
      );
    case 'fields':
      return <FieldList fields={view.fields} />;
    case 'file':
      return (
        <>
          <div className="tx-chip-desc">
            <PathLink path={view.path} />
          </div>
          <CodeLines code={view.content} lang={view.lang} />
          <FieldList fields={view.fields} />
        </>
      );
    default:
      return null;
  }
}

export function FieldList({ fields }: { fields: readonly InputField[] }): ReactNode {
  if (fields.length === 0) return null;
  return (
    <dl className="tx-fields">
      {fields.map((f, i) => (
        <div className="tx-field" key={i}>
          <dt className="tx-field-k">{f.label}</dt>
          <dd className="tx-field-v">{f.path ? <PathLink path={f.value} /> : f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default ToolChip;
