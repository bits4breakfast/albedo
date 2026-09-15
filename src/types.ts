/**
 * Shared contracts for Albedo.
 *
 * Every module in the app codes against this file. Nothing here may be changed
 * unilaterally by a single feature module -- it is the integration surface
 * between the capture pipeline, the shell, the worktree service and the
 * transcript renderer.
 */

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** Lifecycle of a task. Derived from the transcript, never from the pty. */
export type TaskStatus = 'idle' | 'running' | 'blocked' | 'done' | 'archived';

export interface Task {
  id: number;
  title: string;
  /** Absolute path to the origin repository (not the worktree). */
  repoPath: string;
  /** Branch the worktree was cut from. */
  baseBranch: string;
  /** Branch checked out in the worktree. */
  branch: string;
  /** Absolute path to the git worktree this task runs in. */
  worktreePath: string;
  /** Claude Code session id, once a transcript has been matched to the task. */
  sessionId: string | null;
  status: TaskStatus;
  createdAt: number;
  lastActivityAt: number | null;
}

export type NewTask = Omit<Task, 'id' | 'sessionId' | 'status' | 'createdAt' | 'lastActivityAt'>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Role as stored in SQLite. Note this is *not* the raw JSONL `type`: tool calls
 * and tool results are lifted out of assistant/user content blocks into their
 * own rows so that they are individually searchable and renderable.
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';

export interface Message {
  id: number;
  /**
   * Null for sessions captured from a plain terminal that no task claims yet.
   * Capture runs regardless of whether the app launched the session, so this is
   * genuinely nullable -- do not substitute a sentinel 0, it collides with a
   * real task id in filters. Backfilled by the watcher on adoption.
   */
  taskId: number | null;
  sessionId: string;
  /** Monotonic ordering within a session. Line index in the JSONL file. */
  seq: number;
  role: MessageRole;
  /** Set on tool_use / tool_result rows, e.g. "Edit", "Bash". */
  toolName: string | null;
  /** File the tool acted on, when one can be determined. */
  targetPath: string | null;
  /** Plain-text projection used for display and FTS. May be null. */
  body: string | null;
  /** The original JSONL object, verbatim. Never drop this. */
  rawJson: string;
  ts: number;
}

/** A row as produced by the adapter, before it has a database id. */
export type ParsedMessage = Omit<Message, 'id' | 'taskId'>;

// ---------------------------------------------------------------------------
// Raw transcript JSONL
// ---------------------------------------------------------------------------

/**
 * The shapes below describe Claude Code's on-disk transcript format as observed
 * on v2.1.x. This is an INTERNAL format with no compatibility contract -- see
 * src/capture/adapter.ts, which is the only module permitted to know about it.
 */
export interface RawLine {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  message?: RawMessage;
  toolUseResult?: unknown;
  [k: string]: unknown;
}

export interface RawMessage {
  role: 'user' | 'assistant';
  model?: string;
  content: string | RawContentBlock[];
  usage?: RawUsage;
  stop_reason?: string | null;
}

export type RawContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };

export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export type DiffLineKind = 'add' | 'del' | 'context' | 'meta';

export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  kind: DiffLineKind;
  oldNumber: number | null;
  newNumber: number | null;
  content: string;
  /** Word-level breakdown, present on add/del lines that were paired up. */
  segments?: DiffSegment[];
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  /** Path shown in the header. */
  path: string;
  /** Language id for Shiki, resolved from the file extension. */
  lang: string;
  hunks: DiffHunk[];
}

// ---------------------------------------------------------------------------
// pty bridge
// ---------------------------------------------------------------------------

export interface PtySpawnOptions {
  cwd: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  /** Extra environment. ANTHROPIC_API_KEY is always stripped, see pty.rs. */
  env?: Record<string, string>;
}

/** Payload of the `pty://output` Tauri event. */
export interface PtyOutputEvent {
  ptyId: string;
  /** Raw bytes from the pty, base64 encoded. */
  data: string;
}

/** Payload of the `pty://exit` Tauri event. */
export interface PtyExitEvent {
  ptyId: string;
  code: number | null;
}
