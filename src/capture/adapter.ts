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

import type { Message, MessageRole, ParsedMessage } from '../types';

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
// Public API
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
 * to touch the JSONL shape. Not part of the
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

/** An image a user attached, ready for an `<img src>`. */
export interface TranscriptImage {
  /** `data:` URL, built from the block's base64 payload. */
  src: string;
  mediaType: string;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * The image a row stands for, or null.
 *
 * An image block becomes a `[image]` placeholder row (see blockToRow), and the
 * row keeps the whole line in raw_json -- base64 payload included -- so the
 * picture is recovered here, by the block index encoded in `seq`. Only inline
 * base64 sources of the four web image types are returned: anything else (a
 * URL source, an unknown type) stays a placeholder rather than becoming a
 * request the app never meant to make.
 */
export function imageAt(rawJson: string, seq: number): TranscriptImage | null {
  const line = safeParse(rawJson);
  const message = line?.['message'];
  if (!isRecord(message) || !Array.isArray(message['content'])) return null;
  return imageOf((message['content'] as unknown[])[seq % SEQ_STRIDE]);
}

/**
 * Every image a line carries, in order. A message sent while a turn ran is a
 * `queued_command` attachment, whose images sit in `attachment.prompt` rather
 * than `message.content`, and whose row holds the whole prompt as one body
 * with an `[image]` line per picture -- this is how those are recovered.
 */
export function imagesIn(rawJson: string): TranscriptImage[] {
  const line = safeParse(rawJson);
  if (!line) return [];
  const message = line['message'];
  const att = line['attachment'];
  const blocks = isRecord(message) && Array.isArray(message['content'])
    ? (message['content'] as unknown[])
    : isRecord(att) && Array.isArray(att['prompt'])
      ? (att['prompt'] as unknown[])
      : [];
  const out: TranscriptImage[] = [];
  for (const b of blocks) {
    const img = imageOf(b);
    if (img) out.push(img);
  }
  return out;
}

/** An inline base64 image block of a web type, or null. See {@link imageAt}. */
function imageOf(block: unknown): TranscriptImage | null {
  if (!isRecord(block) || block['type'] !== 'image') return null;
  const source = block['source'];
  if (!isRecord(source) || source['type'] !== 'base64') return null;
  const mediaType = source['media_type'];
  const data = source['data'];
  if (typeof mediaType !== 'string' || !IMAGE_TYPES.has(mediaType)) return null;
  if (typeof data !== 'string' || data.length === 0 || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 256))) return null;
  return { src: `data:${mediaType};base64,${data}`, mediaType };
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
 * True for the line that closes a slash command Claude Code ran itself, with
 * no model turn -- `/clear`, `/model`. Without it the command's envelope, a
 * `user` row, reads as a prompt in flight and the task as `running` for the
 * whole recency window.
 *
 * Two shapes, both written by Claude Code 2.1.302: a `system` line with
 * subtype 'local_command' (`/clear`), and a `user` line whose content opens
 * with `<local-command-stdout>` (`/model`).
 */
export function endsLocalCommand(rawJson: string): boolean {
  const line = safeParse(rawJson);
  if (!line) return false;
  if (line['type'] === 'system') return line['subtype'] === 'local_command';
  if (line['type'] !== 'user') return false;
  const message = line['message'];
  if (!isRecord(message)) return false;
  const content = message['content'];
  return typeof content === 'string' && content.trimStart().startsWith('<local-command-stdout>');
}

/**
 * True for a `system` line recording a slash command Claude Code ran itself:
 * the command's envelope (`<command-name>/remote-control</command-name>…`),
 * or its `<local-command-stdout>` (empty for most). Both are stored as
 * `system` rows, so without this the pane printed the envelope under "Sys",
 * and the "sending" echo of the command never cleared: no `user` row follows.
 *
 * Measured on Claude Code 2.1.288-2.1.312 for `/remote-control` (`/rc`),
 * `/rename`, `/resume`, `/context` and `/login`: two lines with the same
 * timestamp, command first. `/clear`, `/model`, `/compact` and `/mcp` were
 * seen only as `user` lines (as was one `/remote-control`), which the pane
 * reads as user rows already. The content is the same envelope either way.
 */
export function isLocalCommandLine(rawJson: string): boolean {
  const line = safeParse(rawJson);
  return line !== null && line['type'] === 'system' && line['subtype'] === 'local_command';
}

/**
 * Messages between sessions, and how the two ends find each other.
 *
 * The receiving line carries `origin: { kind: "peer", msg_id, name, ... }`.
 * The sender's transcript has a `SendMessage` tool_result whose text is JSON
 * holding the same `msg_id` (measured on Claude Code 2.1.3xx). That pair is
 * what says which session sent a message; the sender's name is only a label
 * and can be renamed or shared.
 */
export const SEND_MESSAGE_TOOL = 'SendMessage';

/** `origin.msg_id` of a line another session sent. Null for anything else. */
export function peerMessageIdOf(rawJson: string): string | null {
  const origin = safeParse(rawJson)?.['origin'];
  if (!isRecord(origin) || origin['kind'] !== 'peer') return null;
  const id = origin['msg_id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** The `msg_id` a `SendMessage` tool_result reports as delivered. */
export function sentMessageIdOf(rawJson: string): string | null {
  const message = safeParse(rawJson)?.['message'];
  const content = isRecord(message) ? message['content'] : null;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool_result') continue;
    const inner = block['content'];
    const texts =
      typeof inner === 'string'
        ? [inner]
        : Array.isArray(inner)
          ? inner.flatMap((b) => (isRecord(b) && typeof b['text'] === 'string' ? [b['text']] : []))
          : [];
    for (const text of texts) {
      const id = safeParse(text)?.['msg_id'];
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  return null;
}

/**
 * `isMeta` -- a line Claude Code adds beside a command or a prompt (the
 * "run directly in Claude Code" caveat), never something anyone typed.
 */
export function isMetaLine(rawJson: string): boolean {
  return safeParse(rawJson)?.['isMeta'] === true;
}

/**
 * What a compaction's boundary line records about it. Null fields were absent
 * or of a shape this build does not know, and are shown as nothing.
 */
export interface CompactBoundary {
  /** The line's `uuid`; the summary's `parentUuid` names it. */
  uuid: string | null;
  /** `auto` when Claude Code compacted on its own, `manual` for `/compact`. */
  trigger: 'auto' | 'manual' | null;
  /** Tokens in the context when it was compacted. */
  preTokens: number | null;
  /** How long writing the summary took. */
  durationMs: number | null;
}

/**
 * The boundary Claude Code writes when it compacts a session, or null for any
 * other line: `{type: "system", subtype: "compact_boundary", uuid,
 * compactMetadata: {trigger, preTokens, durationMs, …}}`.
 *
 * Measured on Claude Code 2.1.309-2.1.310, across 16 compactions in 13
 * transcripts: the summary line (`compactSummaryOf`) is always the very next
 * line, its `parentUuid` is this line's `uuid`, and its `timestamp` is ~8 ms
 * EARLIER than this one's -- so a read ordered by `ts` puts it first. Every
 * one was `auto`; `manual` is what Claude Code's own `/compact` records.
 */
export function compactBoundaryOf(rawJson: string): CompactBoundary | null {
  if (!rawJson.includes('compact_boundary')) return null;
  const line = safeParse(rawJson);
  if (!line || line['type'] !== 'system' || line['subtype'] !== 'compact_boundary') return null;
  const meta = isRecord(line['compactMetadata']) ? line['compactMetadata'] : {};
  const trigger = meta['trigger'];
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    uuid: typeof line['uuid'] === 'string' ? line['uuid'] : null,
    trigger: trigger === 'auto' || trigger === 'manual' ? trigger : null,
    preTokens: count(meta['preTokens']),
    durationMs: count(meta['durationMs']),
  };
}

/** A compaction's summary: the text Claude Code continues from. */
export interface CompactSummary {
  /** The boundary line it follows, by that line's `uuid`. */
  parentUuid: string | null;
  /** The whole summary, read from the line rather than the (truncated) body. */
  text: string;
}

/**
 * The summary written after a compaction boundary, or null for any other
 * line: a `user` line with `isCompactSummary: true` (and
 * `isVisibleInTranscriptOnly`), whose content opens "This session is being
 * continued from a previous conversation…". Nobody typed it, so nothing may
 * treat it as a prompt; `queueFactsIn` already skips it.
 */
export function compactSummaryOf(rawJson: string): CompactSummary | null {
  if (!rawJson.includes('isCompactSummary')) return null;
  const line = safeParse(rawJson);
  if (!line || line['type'] !== 'user' || line['isCompactSummary'] !== true) return null;
  const message = line['message'];
  const text = isRecord(message) ? textOfUnknown(message['content']) : null;
  return {
    parentUuid: typeof line['parentUuid'] === 'string' ? line['parentUuid'] : null,
    text: text ?? '',
  };
}

/**
 * A notice Claude Code writes into the session for the reader, not the model:
 * `{type: "system", subtype: "informational", level, content}`. Not specific
 * to compaction -- across 21 such lines here, 16 sat after a boundary (the
 * "compacted while idle" note, ~450 ms later, with only `attachment` lines
 * between), the rest elsewhere. So it says nothing on its own about what it
 * is: where it sits is the only structural fact, and the caller decides.
 */
export function isNoticeLine(rawJson: string): boolean {
  if (!rawJson.includes('informational')) return false;
  const line = safeParse(rawJson);
  return line?.['type'] === 'system' && line['subtype'] === 'informational';
}

/**
 * Remote Control turning on: `{type: "system", subtype: "bridge_status",
 * content: "/remote-control is active · Continue here, on your phone, or at
 * https://claude.ai/code/session_…", url: "https://claude.ai/code/session_…"}`.
 * Stored as a `system` row; the `bridge-session` lines that follow are
 * bookkeeping and are not.
 *
 * Measured on Claude Code 2.1.296-2.1.312: 11 such lines, all "is active", all
 * with `url`. No line is written when it goes off -- it ends with the process
 * -- so this says only that it came on, and when (the row's `ts`).
 */
export const REMOTE_CONTROL_SUBTYPE = 'bridge_status';

/** The session's claude.ai link from a "Remote Control is active" line, else null. */
export function remoteControlUrlOf(rawJson: string): string | null {
  if (!rawJson.includes(REMOTE_CONTROL_SUBTYPE)) return null;
  const line = safeParse(rawJson);
  if (!line || line['type'] !== 'system' || line['subtype'] !== REMOTE_CONTROL_SUBTYPE) return null;
  if (line['isSidechain'] === true) return null;
  const content = typeof line['content'] === 'string' ? line['content'] : '';
  if (!content.includes('is active')) return null;
  const url = line['url'];
  if (typeof url === 'string' && url.trim() !== '') return url.trim();
  // A build that carries the link only in the text.
  return /https?:\/\/\S+/.exec(content)?.[0] ?? null;
}

/**
 * SQLite predicate preselecting rows that may be a Remote Control line, so a
 * lookup parses a handful of rows instead of a session. `instr`, not LIKE: the
 * needle's `_` would be a wildcard. Confirm each hit with `remoteControlUrlOf`.
 */
export function remoteControlSqlPredicate(column = 'raw_json'): string {
  return `instr(${column}, '"subtype":"${REMOTE_CONTROL_SUBTYPE}"') > 0`;
}

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

/**
 * One change to Claude Code's input queue: what was typed (or injected) while
 * a turn was running, and what became of it.
 *
 * Claude Code writes these as `queue-operation` lines, in real time:
 *  - `enqueue` carries the text, written the moment Enter is pressed;
 *  - `dequeue` carries nothing and takes the OLDEST entry, when it starts
 *    the next turn with it;
 *  - `remove` carries the text of the entry it takes, when the entry was
 *    folded into the turn already running (`absorbed_mid_turn`) or withdrawn.
 *
 * Measured across 65 transcripts on Claude Code 2.1.303: 1030 enqueues,
 * 571 dequeues, 457 removes. Content was always a string.
 */
export type QueueOperation =
  | { op: 'enqueue'; sessionId: string; text: string; ts: number }
  | { op: 'dequeue'; sessionId: string; ts: number }
  | { op: 'remove'; sessionId: string; text: string; ts: number };

/**
 * The text of a message the person sent while a turn was running, which
 * Claude Code folded into that turn instead of starting a new one. Null for
 * every other attachment.
 *
 * Such a message is written ONLY as a `queued_command` attachment: no `user`
 * line follows it, so without this it never appears in the transcript. A
 * message that starts a new turn instead gets an ordinary `user` line and no
 * attachment, so nothing is shown twice. Only `origin.kind === "human"`: the
 * same attachment also carries task notifications and agent-to-agent
 * messages (measured: 184 human of 488).
 */
export function absorbedPromptText(line: Record<string, unknown>): string | null {
  const att = line['attachment'];
  if (!isRecord(att) || att['type'] !== 'queued_command') return null;
  const origin = att['origin'];
  if (!isRecord(origin) || origin['kind'] !== 'human') return null;
  const text = textOfUnknown(att['prompt']);
  return text && text.trim() !== '' ? text : null;
}

/** The queue operations in a chunk, in order. Same cheap pre-filter as titles. */
export function queueOperationsIn(text: string): QueueOperation[] {
  const out: QueueOperation[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0 || !line.includes('"queue-operation"')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== 'queue-operation') continue;
    const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : '';
    const parsed = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const ts = Number.isNaN(parsed) ? 0 : parsed;
    const content = typeof obj.content === 'string' ? obj.content : null;
    if (obj.operation === 'enqueue' && content !== null) out.push({ op: 'enqueue', sessionId, text: content, ts });
    else if (obj.operation === 'dequeue') out.push({ op: 'dequeue', sessionId, ts });
    else if (obj.operation === 'remove' && content !== null) out.push({ op: 'remove', sessionId, text: content, ts });
    // Any other operation is unknown: ignored rather than guessed at.
  }
  return out;
}

/**
 * Everything the queue model reconciles against, in file order: the queue's
 * own operations, plus two facts that say what became of entries a `dequeue`
 * did not account for.
 *  - `prompt`: a main-thread `user` line that starts a turn, with its typed
 *    text (what an `enqueue` records). Claude Code does not always write
 *    one `dequeue` per message it takes: seen on 2.1.302 while the API was
 *    unreachable, four enqueues, then one `dequeue` and one `user` line
 *    holding only the newest text. The other three were never sent, and no
 *    line says so.
 *  - `turn-end`: a main-thread assistant line whose stop_reason ends the turn
 *    (TURN_ENDING_STOP_REASONS). A typed entry still waiting when a turn ends
 *    is taken at once (measured: within 3 s in every case on this machine);
 *    one that is not is never coming.
 *  - `turn-stop`: any other line that says the session is back at its
 *    prompt, for the outbox's turn (src/ui/transcript/turn.ts); the queue
 *    ignores it. Claude Code's `system` `turn_duration` line (after every
 *    turn end, interrupts included: 1934 of them in 150 sessions here, after
 *    `end_turn`, `stop_sequence` and `[Request interrupted…]`), the
 *    `[Request interrupted…]` line itself (Esc, or a refused dialog), and
 *    the lines that close a command run without a turn (`endsLocalCommand`,
 *    and `<bash-stdout>` / `<bash-stderr>` for `!` input).
 *  - `turn-step`: proof that a turn is running, whatever started it, for the
 *    outbox's turn too. Claude Code's `api-request` line for a main-thread
 *    call (`querySource` `repl_main_thread`, every 2.1.30x here), written
 *    as the call starts, and a main-thread assistant line that does not
 *    end the turn. A turn Claude Code starts from its own queue begins with
 *    an `isMeta` line, which is no `prompt`: these are its first signs. An
 *    API error line is not one: it says a turn failed.
 *    If a Claude Code version stops writing `api-request` (2.1.278-2.1.299
 *    did not), a queue-started turn shows no sign until its first assistant
 *    line, and a release in that gap types into it: that reopens #61, not
 *    just a delay. Re-check this when the transcript format changes.
 */
export type QueueFact =
  | QueueOperation
  | { op: 'prompt'; sessionId: string; text: string; ts: number }
  | { op: 'turn-end'; sessionId: string; ts: number }
  | { op: 'turn-stop'; sessionId: string; ts: number }
  | { op: 'turn-step'; sessionId: string; ts: number };

/** Text of a `user` line that closes what started without a model turn ending it. */
const STOPPING_PROMPT = /^(?:\[Request interrupted|<local-command-stdout>|<bash-stdout>|<bash-stderr>)/;

/**
 * The queue facts in a chunk, in order. Pre-filtered on substrings that occur
 * only as real keys (a quote inside a JSON string is escaped), so tool results
 * and most other lines are rejected before any JSON.parse.
 */
export function queueFactsIn(text: string): QueueFact[] {
  const out: QueueFact[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    if (line.includes('"queue-operation"')) {
      out.push(...queueOperationsIn(line));
      continue;
    }
    const prompt = line.includes('"type":"user"') && !line.includes('"tool_use_id"') && !line.includes('"isMeta":true');
    const assistant = line.includes('"type":"assistant"');
    const stopping = line.includes('"subtype":"turn_duration"') || line.includes('"subtype":"local_command"');
    const request = line.includes('"type":"api-request"') && line.includes('"querySource":"repl_main_thread"');
    if (!prompt && !assistant && !stopping && !request) continue;
    const obj = safeParse(line);
    if (!obj || obj['isSidechain'] === true) continue;
    const sessionId = stringOr(obj['sessionId'], '');
    const ts = parseTs(obj['timestamp']);
    if (obj['type'] === 'api-request') {
      if (obj['querySource'] === 'repl_main_thread') out.push({ op: 'turn-step', sessionId, ts });
      continue;
    }
    if (obj['type'] === 'system') {
      if (obj['subtype'] === 'turn_duration' || obj['subtype'] === 'local_command') out.push({ op: 'turn-stop', sessionId, ts });
      continue;
    }
    if (obj['type'] === 'assistant') {
      if (TURN_ENDING_STOP_REASONS.has(stopReasonOf(line) ?? '')) out.push({ op: 'turn-end', sessionId, ts });
      else if (obj['isApiErrorMessage'] !== true) out.push({ op: 'turn-step', sessionId, ts });
      continue;
    }
    // A meta line or a compaction summary starts no turn, and a summary
    // quotes recent messages -- queued ones included. Other envelopes Claude
    // Code writes as user lines (`[Request interrupted…]`, `<command-name>…`,
    // `<local-command-stdout>…`) do count: they match no typed entry, and
    // reading one as a turn start only delays an idle clear, never forces one.
    if (obj['type'] !== 'user' || obj['isMeta'] === true || obj['isCompactSummary'] === true) continue;
    // Text blocks only: an image's own block is not part of what was typed,
    // which already says `[Image #N]`.
    const blocks = contentBlocksOf(obj);
    const message = obj['message'];
    const body = blocks
      ? blocks.flatMap((b) => (isRecord(b) && b['type'] === 'text' && typeof b['text'] === 'string' ? [b['text']] : [])).join('\n')
      : isRecord(message) && typeof message['content'] === 'string'
        ? message['content']
        : '';
    if (body.trim() !== '') out.push({ op: 'prompt', sessionId, text: body, ts });
    if (STOPPING_PROMPT.test(body.trimStart())) out.push({ op: 'turn-stop', sessionId, ts });
  }
  return out;
}

/**
 * Queue entries Claude Code puts there itself rather than the person typing:
 * a background task finishing, a subagent's message, another session's. They take part in the
 * queue's order -- a `dequeue` can take one -- but are not "your message".
 */
export function isInjectedQueueText(text: string): boolean {
  return /^<(task-notification|agent-message|cross-session-message)\b/.test(text.trimStart());
}

/**
 * The permission modes Claude Code names, as written in the transcript. A value
 * outside this list is a mode this build does not know, and reads as unknown
 * rather than as the nearest guess.
 */
export const PERMISSION_MODES = ['default', 'auto', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * The permission mode a line records for its session, or undefined if it
 * records none. `mode` is null for a value this build does not recognise.
 *
 * Two lines carry it: `{type: "permission-mode", permissionMode, sessionId}`,
 * and the top-level `permissionMode` on the `user` line of a prompt (not on
 * tool results). Subagent lines are skipped: they are stored under the
 * parent's session id, and the mode they ran in is not the session's.
 *
 * Measured on Claude Code 2.1.308: across 108 transcripts, 3,268
 * `permission-mode` lines, all `auto`, and 2,009 `user` lines with the field,
 * 1,992 `auto` and 17 `default`; subagent files carried none. `claude -p
 * --permission-mode plan` (and `acceptEdits`) wrote that value on the prompt's
 * `user` line, and no `permission-mode` line. The six names are the enum in
 * that build. Not measured: whether ⇧⇥ alone, without a prompt, writes a line;
 * this code assumes it does not, so the mode is as of the last prompt sent.
 */
export function permissionModeOf(rawLine: string): { sessionId: string; mode: PermissionMode | null } | undefined {
  const line = safeParse(rawLine);
  if (!line) return undefined;
  if (line['type'] !== 'permission-mode' && line['type'] !== 'user') return undefined;
  if (line['isSidechain'] === true) return undefined;
  const value = line['permissionMode'];
  const sessionId = line['sessionId'];
  if (typeof value !== 'string' || typeof sessionId !== 'string' || sessionId === '') return undefined;
  const mode = (PERMISSION_MODES as readonly string[]).includes(value) ? (value as PermissionMode) : null;
  return { sessionId, mode };
}

/** The latest mode per session in a chunk. Same cheap pre-filter as titles. */
export function permissionModesIn(text: string): Map<string, PermissionMode | null> {
  const out = new Map<string, PermissionMode | null>();
  for (const line of text.split('\n')) {
    if (line.length === 0 || !line.includes('"permissionMode"')) continue;
    const seen = permissionModeOf(line);
    if (seen) out.set(seen.sessionId, seen.mode);
  }
  return out;
}

/**
 * Prefixes marking a `user` row that Claude Code injected rather than the human
 * typing it: slash-command envelopes (`<command-name>…`), system reminders, and
 * interruption notices (`[Request interrupted…]`).
 *
 * Measured on this machine: 75 of 115 sessions open with one of these, and
 * taking the naive first user row as a session label yields only 43 distinct
 * labels across 115 sessions. Skipping them yields 79 distinct across 97.
 */
export const INJECTED_PROMPT_PREFIXES: readonly string[] = ['<', '['];

/**
 * SQLite predicate selecting user bodies the human actually typed.
 *
 * Lives here rather than in a query because "a body starting with `<` is an
 * injected command envelope" is knowledge of Claude Code's format, and this
 * file is the only one allowed to hold that.
 */
export function prosePromptSqlPredicate(column = 'body'): string {
  const notPrefixed = INJECTED_PROMPT_PREFIXES.map(
    (p) => `${column} NOT LIKE '${p}%'`,
  ).join(' AND ');
  return `${column} IS NOT NULL AND TRIM(${column}) != '' AND ${notPrefixed}`;
}

/** JSON path to the git branch recorded on a user/assistant line envelope. */
export const GIT_BRANCH_JSON_PATH = '$.gitBranch';

/** SQLite expression reading the branch off a raw_json column. */
export function gitBranchSqlExpr(column = 'raw_json'): string {
  return `json_extract(${column}, '${GIT_BRANCH_JSON_PATH}')`;
}

/** `isSidechain` — true for subagent traffic. See the watcher's scan comment. */
export function isSidechainOf(rawJson: string): boolean {
  const line = safeParse(rawJson);
  return line?.['isSidechain'] === true;
}

/** The `cwd` recorded on a line, used by the watcher to match a task. */
export function cwdOf(rawJson: string): string | null {
  const line = safeParse(rawJson);
  if (!line) return null;
  const cwd = line['cwd'];
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

// ---------------------------------------------------------------------------
// Tool rows, for the transcript renderer
// ---------------------------------------------------------------------------
//
// A row's `rawJson` is either the whole transcript line or the individual
// content block, so every accessor tries both shapes and returns a safe empty
// value rather than assuming a key exists.

type ToolRow = Pick<Message, 'rawJson' | 'seq' | 'toolName'>;

/** Content blocks of a transcript line, or of a bare `{content}` object. */
function blocksOfRow(raw: Record<string, unknown>): unknown[] {
  if (Array.isArray(raw['content'])) return raw['content'];
  return contentBlocksOf(raw) ?? [];
}

/**
 * The block this row came from. `seq % SEQ_STRIDE` is its index in the line,
 * the only way to disambiguate a line carrying two calls to the same tool.
 */
function blockFor(message: ToolRow, type: 'tool_use' | 'tool_result'): Record<string, unknown> | null {
  const raw = safeParse(message.rawJson);
  if (!raw) return null;
  if (raw['type'] === type) return raw;

  const blocks = blocksOfRow(raw);
  const byIndex = blocks[message.seq % SEQ_STRIDE];
  if (isRecord(byIndex) && byIndex['type'] === type) {
    if (type === 'tool_result' || message.toolName === null || byIndex['name'] === message.toolName) return byIndex;
  }
  const matching = blocks.filter((b): b is Record<string, unknown> => isRecord(b) && b['type'] === type);
  const byName = message.toolName ? matching.find((b) => b['name'] === message.toolName) : undefined;
  return byName ?? matching[0] ?? null;
}

/** Input object of a `tool_use` row. Always an object, possibly empty. */
export function toolInputOf(message: ToolRow): Record<string, unknown> {
  const block = blockFor(message, 'tool_use');
  if (block && isRecord(block['input'])) return block['input'];
  const raw = safeParse(message.rawJson);
  if (raw && isRecord(raw['input'])) return raw['input'];
  return {};
}

function textOf(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function flattenContent(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((b) => (isRecord(b) ? (textOf(b['text']) ?? textOf(b['content']) ?? '') : typeof b === 'string' ? b : ''))
      .filter((s) => s.length > 0)
      .join('\n');
  }
  if (isRecord(v)) {
    const stdout = textOf(v['stdout']);
    const stderr = textOf(v['stderr']);
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
export function toolResultTextOf(message: (ToolRow & Pick<Message, 'body'>) | null | undefined): string {
  if (!message) return '';
  const block = blockFor(message, 'tool_result');
  if (block) {
    const text = flattenContent(block['content']);
    if (text.length > 0) return text;
  }
  const raw = safeParse(message.rawJson);
  if (raw) {
    const text = flattenContent(raw['toolUseResult']);
    if (text.length > 0) return text;
  }
  return message.body ?? '';
}

/** True when the result reported failure: an error, a denial, or an interrupt. */
export function toolResultIsErrorOf(message: ToolRow | null | undefined): boolean {
  if (!message) return false;
  const block = blockFor(message, 'tool_result');
  if (block && block['is_error'] === true) return true;
  const raw = safeParse(message.rawJson);
  if (raw) {
    if (raw['is_error'] === true) return true;
    if (raw['toolDenialKind'] !== undefined && raw['toolDenialKind'] !== null) return true;
    const tur = raw['toolUseResult'];
    if (isRecord(tur) && tur['interrupted'] === true) return true;
  }
  return false;
}

/** `tool_use_id` linking a result row back to its call, from either shape. */
export function toolUseIdOf(message: ToolRow & Pick<Message, 'role'>): string | null {
  const raw = safeParse(message.rawJson);
  if (!raw) return null;
  if (message.role === 'tool_use') {
    const block = blockFor(message, 'tool_use');
    return textOf(block?.['id']) ?? textOf(raw['id']);
  }
  const block = blockFor(message, 'tool_result');
  return textOf(block?.['tool_use_id']) ?? textOf(raw['tool_use_id']);
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
  const absorbed = type === 'attachment' ? absorbedPromptText(line) : null;
  if (!PERSISTED_LINE_TYPES.has(type) && absorbed === null) return [];

  const base = {
    sessionId: stringOr(line['sessionId'], ''),
    ts: parseTs(line['timestamp']),
    rawJson: raw,
    /*
     * Present only on subagent lines, where `sessionId` is the PARENT's. It is
     * the rest of the row's identity: without it a subagent's seq 0 is the
     * same key as its parent's seq 0 and the row is dropped. See migration 5.
     */
    agentId: stringOr(line['agentId'], '') || null,
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
    agentId: base.agentId,
    ts: base.ts,
  });

  if (absorbed !== null) return [emit(0, 'user', absorbed, null, null)];

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
