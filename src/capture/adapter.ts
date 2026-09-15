/**
 * src/capture/adapter.ts
 *
 * THE ONLY module in Albedo allowed to know the Claude Code transcript JSONL
 * format (CLAUDE.md hard rule #1). Everything downstream consumes `Message`
 * from src/types.ts. A format change must be a one-file fix, here.
 *
 * Format reference: docs/TRANSCRIPT-FORMAT.md (observed on Claude Code v2.1.x).
 *
 * Invariants this module guarantees to the rest of the app:
 *
 *  - It NEVER throws. Transcripts are read while Claude Code is mid-append, so
 *    a truncated tail line is normal, not exceptional. Bad input yields `[]`.
 *  - `rawJson` is the verbatim original line, on every row produced from it.
 *    It is never re-serialised, because history is reprocessable only if the
 *    original bytes survive (CLAUDE.md hard rule #2).
 *  - `seq = lineIndex * SEQ_STRIDE + blockIndex`, so one JSONL line can expand
 *    into several rows without renumbering anything that came before.
 */

import type { MessageRole, ParsedMessage } from '../types';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Seq stride per JSONL line. A line expanding into >= SEQ_STRIDE blocks would
 * spill into the next line's range; in practice assistant lines carry fewer
 * than a dozen blocks. A spilled row simply loses the race against the
 * messages_session_seq unique index (INSERT OR IGNORE), it never corrupts
 * ordering of the rows that did land.
 */
export const SEQ_STRIDE = 100;

/**
 * `body` is the FTS / display projection. Tool results can be megabytes (a
 * whole file Read, a huge grep). Truncate the projection; `rawJson` keeps
 * everything, so nothing is actually lost.
 */
export const BODY_MAX_CHARS = 20_000;

const TRUNCATION_MARKER = '\n… [truncated by Albedo; full payload in raw_json]';

/**
 * JSONL line types that become `messages` rows. This is an ALLOWLIST on
 * purpose: Claude Code adds new bookkeeping line types regularly (observed on
 * this machine, beyond what docs/TRANSCRIPT-FORMAT.md lists: `pr-link`,
 * `custom-title`, `agent-name`, `worktree-state`, `relocated`, `cost-state`,
 * `file-history-delta`, `frame-link`, `artifact-autoreact-ledger`,
 * `artifact-comment-monitor`). An allowlist means a new bookkeeping type is
 * ignored by default rather than polluting history.
 */
const PERSISTED_LINE_TYPES = new Set(['user', 'assistant', 'system']);

/**
 * Documented for humans only — the parser is allowlist-driven, so this set is
 * not consulted. Kept so the "why is X missing?" question has an answer here.
 */
export const BOOKKEEPING_LINE_TYPES: readonly string[] = [
  'mode',
  'permission-mode',
  'atis-latch',
  'ai-title',
  'custom-title',
  'last-prompt',
  'bridge-session',
  'queue-operation',
  'file-history-snapshot',
  'file-history-delta',
  'agent-name',
  'pr-link',
  'frame-link',
  'worktree-state',
  'relocated',
  'cost-state',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'attachment',
  'summary',
];

/** Input keys that name the file a tool acted on, in priority order. */
const PATH_INPUT_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/** Input keys worth putting on the first line of a tool_use `body`. */
const PRIMARY_INPUT_KEYS = [
  'command',
  'file_path',
  'path',
  'notebook_path',
  'pattern',
  'query',
  'url',
  'skill',
  'description',
] as const;

// ---------------------------------------------------------------------------
// Public API (frozen in docs/INTERFACES.md for the two parse functions)
// ---------------------------------------------------------------------------

/**
 * Parse one JSONL line into 0..n rows.
 *
 * Standalone use cannot pair a `tool_result` back to its `tool_use` (the call
 * lives on an earlier line), so `toolName` is null on tool_result rows. Use
 * `parseTranscript` for a stream, which carries the pairing map across lines.
 */
export function parseLine(raw: string, lineIndex: number): ParsedMessage[] {
  return parseLineWithContext(raw, lineIndex, new Map());
}

/**
 * Parse a chunk of JSONL. `fromLineIndex` is the line index of the FIRST line
 * of `text` within its file, so the watcher can tail from a byte offset and
 * still produce seq values that continue where the previous chunk stopped.
 *
 * `text` must contain only complete lines; the watcher holds back a partial
 * trailing line until the newline arrives. If one slips through anyway it
 * fails to parse and is dropped, which is the correct outcome either way.
 */
export function parseTranscript(text: string, fromLineIndex = 0): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  const pairing: ToolUsePairing = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    const rows = parseLineWithContext(line, fromLineIndex + i, pairing);
    for (const r of rows) out.push(r);
  }
  return out;
}

/**
 * Number of line slots `parseTranscript` consumed from `text`, so the watcher
 * knows which line index the NEXT chunk starts at. A trailing newline does not
 * open a new line; an unterminated final line does count (the watcher never
 * feeds one, but the arithmetic stays correct if it ever does).
 */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split('\n');
  const last = parts[parts.length - 1];
  return last === undefined || last.length === 0 ? parts.length - 1 : parts.length;
}

/**
 * Format-aware accessors used by status.ts / usage.ts so that THEY never have
 * to touch the JSONL shape. Additive to docs/INTERFACES.md; not part of the
 * public capture surface re-exported by src/capture/index.ts.
 */

/**
 * The tool-call id a row participates in: `message.content[].id` for a
 * `tool_use` row, `message.content[].tool_use_id` for a `tool_result` row.
 * Null for every other role, and for rows whose raw_json will not parse.
 *
 * A raw line can carry several blocks, so the block is located by seq offset
 * (seq % SEQ_STRIDE is the block index it came from).
 */
export function toolCallIdOf(m: Pick<ParsedMessage, 'role' | 'seq' | 'rawJson'>): string | null {
  if (m.role !== 'tool_use' && m.role !== 'tool_result') return null;
  const line = safeParse(m.rawJson);
  if (!line) return null;
  const blocks = contentBlocksOf(line);
  if (!blocks) return null;
  const block = blocks[m.seq % SEQ_STRIDE];
  if (!isRecord(block)) return null;
  const key = m.role === 'tool_use' ? 'id' : 'tool_use_id';
  const v = block[key];
  return typeof v === 'string' ? v : null;
}

export interface LineUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * `message.usage` off an assistant line. Usage is a property of the LINE, not
 * of the individual block rows it expanded into, so callers must de-duplicate
 * by (sessionId, line index) before summing — see usage.ts.
 *
 * Read defensively: the field set drifts between Claude Code releases.
 */
export function extractUsage(rawJson: string): LineUsage | null {
  const line = safeParse(rawJson);
  if (!line || line['type'] !== 'assistant') return null;
  const message = line['message'];
  if (!isRecord(message)) return null;
  const usage = message['usage'];
  if (!isRecord(usage)) return null;
  const input = num(usage['input_tokens']);
  const output = num(usage['output_tokens']);
  const cacheCreate = num(usage['cache_creation_input_tokens']);
  const cacheRead = num(usage['cache_read_input_tokens']);
  if (input === 0 && output === 0 && cacheCreate === 0 && cacheRead === 0) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cacheCreate,
    cacheReadInputTokens: cacheRead,
  };
}

/**
 * JSON paths to the token counters that together make up the tokens occupying
 * the context window on a turn.
 *
 * All three, not just `input_tokens`. Under prompt caching `input_tokens` is
 * typically a handful of tokens -- a real sample from a session holding ~198k
 * of context read `{input_tokens: 2, cache_read_input_tokens: 186919,
 * cache_creation_input_tokens: 10889}`. Using `input_tokens` alone would
 * report an essentially empty context on a nearly full session, which is the
 * obvious wrong implementation of this metric.
 */
export const USAGE_JSON_PATHS = {
  inputTokens: '$.message.usage.input_tokens',
  cacheReadInputTokens: '$.message.usage.cache_read_input_tokens',
  cacheCreationInputTokens: '$.message.usage.cache_creation_input_tokens',
  outputTokens: '$.message.usage.output_tokens',
} as const;

export type UsageField = keyof typeof USAGE_JSON_PATHS;

/** The three counters that together occupy the context window. */
export const CONTEXT_USAGE_FIELDS: readonly UsageField[] = [
  'inputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
];

export const CONTEXT_USAGE_JSON_PATHS: readonly string[] = CONTEXT_USAGE_FIELDS.map(
  (f) => USAGE_JSON_PATHS[f],
);

/**
 * SQLite expression reading one usage counter out of a raw_json column, 0 when
 * absent. Single source of truth with extractUsage(): both read
 * USAGE_JSON_PATHS, so a transcript change moves them together.
 */
export function usageSqlExpr(field: UsageField, column = 'raw_json'): string {
  return `COALESCE(json_extract(${column}, '${USAGE_JSON_PATHS[field]}'), 0)`;
}

/** JSON path that exists on exactly the lines carrying a usage record. */
export const USAGE_PRESENCE_JSON_PATH = '$.message.usage';

/**
 * SQLite expression summing CONTEXT_USAGE_JSON_PATHS out of a raw_json column.
 *
 * It exists so an aggregate like "peak context across a session" runs in the
 * database instead of shipping every raw line over the IPC bridge to be
 * parsed. It encodes the same fields `extractUsage()` reads, and lives here
 * for the same reason everything else format-shaped does: when the transcript
 * changes, this file is the only one that has to.
 */
export function contextUsedSqlExpr(column = 'raw_json'): string {
  return CONTEXT_USAGE_FIELDS.map((field) => usageSqlExpr(field, column)).join(' + ');
}

/**
 * Tokens occupying the context window on the turn this usage record describes.
 *
 * OCCUPANCY, not consumption. Valid for a SINGLE turn, where the three
 * counters are disjoint parts of one prompt. Summing this across many turns
 * double-counts cached context once per turn -- see the header of
 * src/capture/usage.ts, which computes window totals a different way on
 * purpose.
 */
export function contextUsedFrom(usage: LineUsage): number {
  return usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
}

/** `message.model` off an assistant line, or null. */
export function modelOf(rawJson: string): string | null {
  const line = safeParse(rawJson);
  if (!line || line['type'] !== 'assistant') return null;
  const message = line['message'];
  if (!isRecord(message)) return null;
  const model = message['model'];
  return typeof model === 'string' && model.length > 0 ? model : null;
}

/**
 * `message.stop_reason` off an assistant line, or null.
 *
 * This is how the transcript says the model HANDED CONTROL BACK rather than
 * merely paused: 'end_turn' / 'stop_sequence' mean the turn is finished,
 * 'tool_use' means it is waiting on a tool. status.ts uses it so a finished
 * task reads `idle` instantly instead of pretending to run for 90 more
 * seconds. Null for anything that is not an assistant line, and for lines
 * where the field is absent (older Claude Code builds, API error lines) --
 * callers must fall back rather than assume 'finished'.
 */
export function stopReasonOf(rawJson: string): string | null {
  const line = safeParse(rawJson);
  if (!line || line['type'] !== 'assistant') return null;
  const message = line['message'];
  if (!isRecord(message)) return null;
  const reason = message['stop_reason'];
  return typeof reason === 'string' && reason.length > 0 ? reason : null;
}

/**
 * stop_reason values meaning the model finished its turn and is waiting on
 * the human. Anything else (notably 'tool_use', 'max_tokens', or absent)
 * leaves the decision to the recency window.
 */
export const TURN_ENDING_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'stop_sequence',
]);

/**
 * Session-title line types, mapped to the key each carries the title in.
 *
 * These stay OUT of `messages` -- they are bookkeeping, not conversation, and
 * PERSISTED_LINE_TYPES deliberately excludes them. But a browser listing 115
 * past sessions needs a real title rather than the first 60 characters of the
 * first prompt, so the watcher lifts them into `transcript_files.title`.
 *
 * Observed on this machine: 3,149 `ai-title` lines `{type, aiTitle, sessionId}`
 * and 578 `custom-title` lines `{type, customTitle, sessionId}`.
 */
export const TITLE_LINE_KEYS: Readonly<Record<string, string>> = {
  'ai-title': 'aiTitle',
  'custom-title': 'customTitle',
};

/** Title carried by a single line, or null if it is not a title line. */
export function titleOf(rawLine: string): string | null {
  const line = safeParse(rawLine);
  if (!line) return null;
  const type = line['type'];
  if (typeof type !== 'string') return null;
  const key = TITLE_LINE_KEYS[type];
  if (key === undefined) return null;
  const value = line[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Newest title in a chunk, or null if it carries none. Latest wins, whichever
 * of the two line types it came from.
 *
 * Cheap on purpose: a substring test rejects the ~99% of lines that are not
 * title lines before any JSON.parse happens, so scanning for titles does not
 * double the cost of ingesting a chunk.
 */
export function lastTitleIn(text: string): string | null {
  let found: string | null = null;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    if (!line.includes('"aiTitle"') && !line.includes('"customTitle"')) continue;
    const title = titleOf(line);
    if (title !== null) found = title;
  }
  return found;
}

/** The `cwd` recorded on a line, used by the watcher to match a task. */
export function cwdOf(rawJson: string): string | null {
  const line = safeParse(rawJson);
  if (!line) return null;
  const cwd = line['cwd'];
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** tool_use_id -> what we learned from the tool_use block that opened it. */
type ToolUsePairing = Map<string, { name: string; targetPath: string | null }>;

function parseLineWithContext(
  raw: string,
  lineIndex: number,
  pairing: ToolUsePairing,
): ParsedMessage[] {
  const line = safeParse(raw);
  if (!line) return []; // truncated / malformed / not an object

  const type = line['type'];
  if (typeof type !== 'string') return [];
  if (!PERSISTED_LINE_TYPES.has(type)) return [];

  const base = {
    sessionId: stringOr(line['sessionId'], ''),
    ts: parseTs(line['timestamp']),
    rawJson: raw,
  };

  const emit = (
    blockIndex: number,
    role: MessageRole,
    body: string | null,
    toolName: string | null,
    targetPath: string | null,
  ): ParsedMessage => ({
    sessionId: base.sessionId,
    seq: lineIndex * SEQ_STRIDE + blockIndex,
    role,
    toolName,
    targetPath,
    body: body === null ? null : truncateBody(body),
    rawJson: base.rawJson,
    ts: base.ts,
  });

  if (type === 'system') {
    // `system` lines carry their text at the TOP level (`content`), not under
    // `message`. Many carry no text at all (turn-duration markers); those
    // still become a row so raw_json survives — the renderer filters them.
    return [emit(0, 'system', textOfUnknown(line['content']), null, null)];
  }

  const message = line['message'];
  if (!isRecord(message)) {
    // Shape we do not recognise (e.g. an API-error line missing `message`).
    // Keep one row so the raw line is never lost.
    return [emit(0, type === 'assistant' ? 'assistant' : 'user', null, null, null)];
  }

  const content = message['content'];

  // Typed human prompts arrive as a plain string.
  if (typeof content === 'string') {
    return [emit(0, type === 'assistant' ? 'assistant' : 'user', content, null, null)];
  }

  if (!Array.isArray(content)) {
    return [emit(0, type === 'assistant' ? 'assistant' : 'user', null, null, null)];
  }

  const rows: ParsedMessage[] = [];
  for (let b = 0; b < content.length; b++) {
    const block = content[b];
    const row = blockToRow(block, b, type, pairing, emit);
    if (row) rows.push(row);
  }

  // A content array that expanded to nothing (empty array) still deserves a
  // row: M1 is the irreversible milestone, dropping raw lines is not an option.
  if (rows.length === 0) {
    rows.push(emit(0, type === 'assistant' ? 'assistant' : 'user', null, null, null));
  }
  return rows;
}

function blockToRow(
  block: unknown,
  blockIndex: number,
  lineType: string,
  pairing: ToolUsePairing,
  emit: (
    blockIndex: number,
    role: MessageRole,
    body: string | null,
    toolName: string | null,
    targetPath: string | null,
  ) => ParsedMessage,
): ParsedMessage | null {
  const fallbackRole: MessageRole = lineType === 'assistant' ? 'assistant' : 'user';
  if (!isRecord(block)) return emit(blockIndex, fallbackRole, null, null, null);

  const blockType = block['type'];

  switch (blockType) {
    case 'text':
      return emit(blockIndex, fallbackRole, stringOr(block['text'], ''), null, null);

    case 'thinking': {
      // Extended thinking is persisted as an ordinary `assistant` row; the
      // DISCRIMINATOR the transcript renderer keys off is `toolName ===
      // 'thinking'`. Deliberately NOT a new column (src/db/schema.sql is a
      // shared contract) and deliberately NOT a text prefix on `body`, which
      // would leak a sentinel into FTS results and into displayed text.
      return emit(blockIndex, 'assistant', stringOr(block['thinking'], ''), 'thinking', null);
    }

    case 'tool_use': {
      const name = stringOr(block['name'], 'unknown');
      const input = block['input'];
      const targetPath = targetPathOf(name, input);
      const id = block['id'];
      if (typeof id === 'string') pairing.set(id, { name, targetPath });
      return emit(blockIndex, 'tool_use', summarizeToolUse(name, input), name, targetPath);
    }

    case 'tool_result': {
      const id = block['tool_use_id'];
      const paired = typeof id === 'string' ? pairing.get(id) : undefined;
      const body = toolResultBody(block['content'], block['is_error'] === true);
      return emit(
        blockIndex,
        'tool_result',
        body,
        paired?.name ?? null,
        paired?.targetPath ?? null,
      );
    }

    default: {
      // Unknown / non-text block (image, tool_reference, and whatever ships
      // next). Keep a placeholder row rather than dropping the block, so the
      // raw line is reachable from the timeline at the right position.
      const label = typeof blockType === 'string' ? blockType : 'unknown';
      return emit(blockIndex, fallbackRole, `[${label}]`, null, null);
    }
  }
}

// ---------------------------------------------------------------------------
// Body projections
// ---------------------------------------------------------------------------

function summarizeToolUse(name: string, input: unknown): string {
  if (!isRecord(input)) return name;
  let primary: string | null = null;
  for (const key of PRIMARY_INPUT_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) {
      primary = v;
      break;
    }
  }
  const detail = safeStringify(input);
  const head = primary === null ? name : `${name}: ${primary}`;
  return detail === null ? head : `${head}\n${detail}`;
}

function toolResultBody(content: unknown, isError: boolean): string {
  const text = textOfUnknown(content) ?? '';
  return isError ? `[error] ${text}` : text;
}

/** Best-effort plain text out of a string | block[] | anything else. */
function textOfUnknown(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (isRecord(item)) {
        const t = item['type'];
        if (t === 'text' && typeof item['text'] === 'string') parts.push(item['text']);
        else parts.push(`[${typeof t === 'string' ? t : 'unknown'}]`);
      }
    }
    return parts.join('\n');
  }
  return safeStringify(value);
}

function truncateBody(body: string): string {
  if (body.length <= BODY_MAX_CHARS) return body;
  return body.slice(0, BODY_MAX_CHARS) + TRUNCATION_MARKER;
}

// ---------------------------------------------------------------------------
// Target-path extraction
// ---------------------------------------------------------------------------

/** Characters that mean a Bash token is not a plain literal path. */
const SHELL_METACHARS = /[$`"'|&;()<>*?!\\{}\[\]]/;

function targetPathOf(toolName: string, input: unknown): string | null {
  if (!isRecord(input)) return null;
  for (const key of PATH_INPUT_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  if (toolName === 'Bash') {
    const cmd = input['command'];
    if (typeof cmd === 'string') return firstLiteralPath(cmd);
  }
  return null;
}

/**
 * Only picks a path out of a Bash command when it is trivially unambiguous: a
 * bare token starting with `/`, `./`, `../` or `~/` and free of shell syntax.
 * Anything requiring real shell parsing returns null by design — a wrong
 * target_path is worse than none.
 */
function firstLiteralPath(command: string): string | null {
  for (const token of command.split(/\s+/)) {
    if (token.length < 2) continue;
    if (SHELL_METACHARS.test(token)) continue;
    if (token.startsWith('/') || token.startsWith('./') || token.startsWith('../') || token.startsWith('~/')) {
      return token;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tiny defensive helpers
// ---------------------------------------------------------------------------

function safeParse(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null; // truncated tail line, mid-append — expected, not an error
  }
  return isRecord(value) ? value : null;
}

function safeStringify(value: unknown): string | null {
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s : null;
  } catch {
    return null; // cyclic or otherwise hostile; body is best-effort only
  }
}

function contentBlocksOf(line: Record<string, unknown>): unknown[] | null {
  const message = line['message'];
  if (!isRecord(message)) return null;
  const content = message['content'];
  return Array.isArray(content) ? content : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * ISO 8601 -> epoch ms. An unparseable timestamp yields 0 rather than
 * Date.now(): claiming "just now" for a line of unknown age would make
 * deriveStatus() report a dead session as `running`.
 */
function parseTs(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}
