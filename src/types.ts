/**
 * Shared contracts for Albedo.
 *
 * Every module in the app codes against this file. Nothing here may be changed
 * unilaterally by a single feature module -- it is the integration surface
 * between the capture pipeline, the shell, the worktree service and the
 * transcript renderer.
 */

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * A repository the user works in, and where its worktrees live.
 *
 * Exists so the worktree location is the user's choice rather than a hardcoded
 * `~/agents/<repo>/<slug>` -- an existing layout stays usable instead of having
 * to be migrated to suit the app.
 */
export interface Project {
  id: number;
  /** Display name. Defaults to the repo folder's basename. */
  name: string;
  /** Root folder of the project -- the git repository itself. */
  repoPath: string;
  /** Directory under which this project's worktrees are created. */
  worktreeRoot: string;
  /** Offered as the default base in the new-task dialog. Null = repo HEAD. */
  defaultBaseBranch: string | null;
  /**
   * Prompt handed to `claude` as argv on a task's FIRST spawn, with `{key}`,
   * `{title}` and `{branch}` substituted. Null means no initial prompt, which
   * is the default: prompting an agent the user has just launched is a side
   * effect they did not ask for. Empty string is normalised to null on write,
   * so "unset" has exactly one representation.
   */
  taskPromptTemplate: string | null;
  createdAt: number;
  archivedAt: number | null;
}

/**
 * Write shape for a project.
 *
 * `taskPromptTemplate` is OPTIONAL here while it is required on `Project`:
 * a row always has the column, so a reader must handle the null; but creating
 * a project without an initial prompt is the default and the common case, and
 * making every call site pass an explicit null is ceremony that buys nothing.
 *
 * This is deliberately the opposite of `WindowUsage.cacheReadTokens`, which is
 * required. The rule is: REQUIRED WHERE FORGETTING IS DANGEROUS, OPTIONAL
 * WHERE FORGETTING IS CORRECT. Omitting `cacheReadTokens` silently
 * reintroduces a 38x usage error, so the compiler must insist. Omitting a
 * prompt template does exactly what the user wants, which is nothing.
 */
export type NewProject = Omit<
  Project,
  'id' | 'createdAt' | 'archivedAt' | 'taskPromptTemplate'
> & {
  /** Omit, or pass null/'' , for no initial prompt. Normalised on write. */
  taskPromptTemplate?: string | null;
};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** Lifecycle of a task. Derived from the transcript, never from the pty. */
export type TaskStatus = 'idle' | 'running' | 'blocked' | 'done' | 'archived';

export interface Task {
  id: number;
  title: string;
  /**
   * Owning project. Nullable for rows created before projects existed and
   * backfilled by migration v2; new tasks always carry one.
   */
  projectId: number | null;
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

// ---------------------------------------------------------------------------
// Touched files (M4)
// ---------------------------------------------------------------------------

/** Where the knowledge that a file changed came from. */
export type TouchedSource = 'transcript' | 'git' | 'both';

export interface TouchedFile {
  /** Worktree-relative path. Always relative -- see resolveInWorktree(). */
  path: string;
  /** Number of tool calls in the transcript that targeted this file. */
  editCount: number;
  /** Last time the transcript or git saw this file change. */
  lastTouchedAt: number | null;
  /**
   * The agent can change files outside its edit tool (a Bash `sed`, a
   * generator), so the transcript alone under-reports. `git` means git sees a
   * change the transcript never mentioned.
   */
  source: TouchedSource;
  /** Porcelain status code from `git status`, when git knows about it. */
  gitStatus: string | null;
  /** True once the user saved this file by hand in the built-in editor. */
  handEdited: boolean;
}

// ---------------------------------------------------------------------------
// Opening files (M4)
// ---------------------------------------------------------------------------

export interface OpenFileRequest {
  /** Path as it appeared in the transcript. May be absolute or relative. */
  path: string;
  /** 1-based line to reveal, when the source had one. */
  line?: number | null;
}
