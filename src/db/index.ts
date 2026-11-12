/**
 * src/db/index.ts
 *
 * The SQLite access layer. Owns the snake_case <-> camelCase mapping in ONE
 * place, so a column rename is a single-file change.
 *
 * The task and message reads are the public surface (docs/ARCHITECTURE.md).
 * The other exports (message insertion, transcript_files bookkeeping, task
 * adoption) are for src/capture only.
 */

import Database from '@tauri-apps/plugin-sql';
import type { ApiErrorKind, Message, MessageRole, NewTask, ParsedMessage, Task, TaskStatus } from '../types';
import {
  backgroundFactsOf,
  backgroundSqlPredicate,
  contextUsedSqlExpr,
  remoteControlSqlPredicate,
  remoteControlUrlOf,
  SEQ_STRIDE,
  usageSqlExpr,
  USAGE_PRESENCE_JSON_PATH,
} from '../capture/adapter';

const DB_URL = 'sqlite:albedo.db';

/**
 * SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999 on older builds. Staying
 * under it keeps batched inserts portable regardless of how the bundled
 * sqlite was compiled.
 */
const MAX_BIND_PARAMS = 900;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let dbPromise: Promise<Database> | null = null;

/** Memoised connection. Concurrent callers share one `Database.load`. */
export function getDb(): Promise<Database> {
  if (dbPromise === null) {
    dbPromise = Database.load(DB_URL).catch((err: unknown) => {
      dbPromise = null; // let the next caller retry instead of caching a failure
      throw err;
    });
  }
  return dbPromise;
}

/** Test/teardown hook: drop the memoised handle. */
export function resetDb(): void {
  dbPromise = null;
  forgetContextPeaks();
  forgetUsageHours();
}

// ---------------------------------------------------------------------------
// Task change notification
// ---------------------------------------------------------------------------

const taskListeners = new Set<() => void>();

/**
 * Fires after any write that mutates a `tasks` row: createTask, updateTask,
 * archiveTask, and the capture watcher adopting a session id or bumping
 * last_activity_at. In-process only -- one app, one window -- so a module-level
 * Set is the whole mechanism.
 *
 * @returns unsubscribe
 */
export function onTasksChanged(cb: () => void): () => void {
  taskListeners.add(cb);
  return () => {
    taskListeners.delete(cb);
  };
}

/**
 * Notify task listeners. Exported for the capture watcher, which mutates task
 * rows through touchTaskActivity/adoptSessionIntoTask. A throwing listener
 * must not abort the others or fail the write that triggered it.
 */
export function emitTasksChanged(): void {
  for (const cb of [...taskListeners]) {
    try {
      cb();
    } catch {
      // a broken subscriber is not the writer's problem
    }
  }
}

// ---------------------------------------------------------------------------
// Column mapping — the single place snake_case meets camelCase
// ---------------------------------------------------------------------------

interface TaskRow {
  id: number;
  title: string;
  project_id: number | null;
  repo_path: string;
  base_branch: string;
  branch: string;
  worktree_path: string;
  session_id: string | null;
  owns_worktree: number;
  created_branch: number | null;
  kind: string;
  status: string;
  created_at: number;
  last_activity_at: number | null;
  seen_at: number | null;
  summary: string | null;
  review_url?: string | null;
  api_error?: string | null;
  api_error_text?: string | null;
  spun_from_task_id?: number | null;
}

interface MessageRow {
  id: number;
  task_id: number | null;
  session_id: string;
  seq: number;
  role: string;
  tool_name: string | null;
  target_path: string | null;
  body: string | null;
  raw_json: string;
  /** Null on every main-session row; the subagent's id on a sidechain row. */
  agent_id: string | null;
  ts: number;
}

const TASK_COLUMN: Readonly<Record<keyof Task, string>> = {
  id: 'id',
  title: 'title',
  projectId: 'project_id',
  repoPath: 'repo_path',
  baseBranch: 'base_branch',
  branch: 'branch',
  worktreePath: 'worktree_path',
  sessionId: 'session_id',
  ownsWorktree: 'owns_worktree',
  createdBranch: 'created_branch',
  kind: 'kind',
  status: 'status',
  createdAt: 'created_at',
  lastActivityAt: 'last_activity_at',
  seenAt: 'seen_at',
  summary: 'summary',
  reviewUrl: 'review_url',
  apiError: 'api_error',
  apiErrorText: 'api_error_text',
  spunFromTaskId: 'spun_from_task_id',
};

const TASK_SELECT =
  'id, title, project_id, repo_path, base_branch, branch, worktree_path, session_id, owns_worktree, created_branch, kind, status, created_at, last_activity_at, seen_at, summary, review_url, api_error, api_error_text, spun_from_task_id';
const MESSAGE_SELECT = 'id, task_id, session_id, seq, role, tool_name, target_path, body, raw_json, agent_id, ts';

const API_ERROR_KINDS: ReadonlySet<string> = new Set<ApiErrorKind>([
  'stopped',
  'slept',
  'offline',
  'overloaded',
  'rate-limited',
  'signed-out',
  'other',
]);

/** A stored `api_error`: null stays null, a value this build does not know reads as 'other'. */
function apiErrorKind(v: string | null | undefined): ApiErrorKind | null {
  if (v === null || v === undefined) return null;
  return (API_ERROR_KINDS.has(v) ? v : 'other') as ApiErrorKind;
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'idle',
  'running',
  'blocked',
  'done',
  'archived',
]);

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    // Null only for rows predating projects that the v2 backfill has not
    // linked yet; tasks created from here on always carry one.
    projectId: r.project_id,
    repoPath: r.repo_path,
    baseBranch: r.base_branch,
    branch: r.branch,
    worktreePath: r.worktree_path,
    sessionId: r.session_id,
    // SQLite has no boolean type; anything non-zero is true.
    ownsWorktree: r.owns_worktree !== 0,
    createdBranch: r.created_branch === null ? null : r.created_branch !== 0,
    // Anything but 'chat' is work: the safe reading of an unknown value is
    // the kind every task was before v8.
    kind: r.kind === 'chat' ? 'chat' : 'work',
    status: (VALID_STATUSES.has(r.status) ? r.status : 'idle') as TaskStatus,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
    seenAt: r.seen_at,
    // Absent only on a database older than v11 that a test hands over.
    summary: r.summary ?? null,
    // Absent only on a database older than v13 that a test hands over.
    reviewUrl: r.review_url ?? null,
    // Absent only on a database older than v16 that a test hands over. The
    // text is kept only beside a kind: null together, as the type says.
    apiError: apiErrorKind(r.api_error),
    apiErrorText: apiErrorKind(r.api_error) === null ? null : (r.api_error_text ?? ''),
    // Absent only on a database older than v17 that a test hands over.
    spunFromTaskId: r.spun_from_task_id ?? null,
  };
}

function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    // null, never a sentinel 0: capture runs for sessions started outside the
    // app, and a 0 would collide with a real id in a task filter.
    taskId: r.task_id,
    sessionId: r.session_id,
    seq: r.seq,
    role: r.role as MessageRole,
    toolName: r.tool_name,
    targetPath: r.target_path,
    body: r.body,
    rawJson: r.raw_json,
    agentId: r.agent_id ?? null,
    ts: r.ts,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function listTasks(opts?: { includeArchived?: boolean }): Promise<Task[]> {
  const db = await getDb();
  const where = opts?.includeArchived === true ? '' : " WHERE status != 'archived'";
  const rows = await db.select<TaskRow[]>(
    `SELECT ${TASK_SELECT} FROM tasks${where} ORDER BY COALESCE(last_activity_at, created_at) DESC, id DESC`,
  );
  return rows.map(toTask);
}

export async function getTask(id: number): Promise<Task | null> {
  const db = await getDb();
  const rows = await db.select<TaskRow[]>(`SELECT ${TASK_SELECT} FROM tasks WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? toTask(row) : null;
}

export async function createTask(t: NewTask): Promise<Task> {
  const db = await getDb();
  const createdAt = Date.now();
  const res = await db.execute(
    // owns_worktree is written EXPLICITLY, never left to the column default.
    // The schema default exists to backfill pre-v4 rows; as a forward default
    // it points the dangerous way (1 = "Albedo may delete this directory"), so
    // no insert from here is allowed to fall through to it.
    // created_branch likewise: NULL is reserved for pre-v6 rows. And kind:
    // its default backfills pre-v8 rows, and is not a decision for new ones.
    `INSERT INTO tasks (title, project_id, repo_path, base_branch, branch, worktree_path, session_id, owns_worktree, created_branch, kind, status, created_at, last_activity_at, seen_at, summary, review_url, spun_from_task_id)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $9, $10, 'idle', $8, NULL, NULL, NULL, $11, $12)`,
    [
      t.title,
      t.projectId,
      t.repoPath,
      t.baseBranch,
      t.branch,
      t.worktreePath,
      t.ownsWorktree ? 1 : 0,
      createdAt,
      t.createdBranch === null ? null : t.createdBranch ? 1 : 0,
      t.kind === 'chat' ? 'chat' : 'work',
      t.reviewUrl ?? null,
      t.spunFromTaskId ?? null,
    ],
  );
  const id = res.lastInsertId;
  if (typeof id !== 'number') {
    throw new Error('createTask: driver returned no lastInsertId');
  }
  emitTasksChanged();
  return {
    id,
    title: t.title,
    projectId: t.projectId,
    repoPath: t.repoPath,
    baseBranch: t.baseBranch,
    branch: t.branch,
    worktreePath: t.worktreePath,
    sessionId: null,
    ownsWorktree: t.ownsWorktree,
    createdBranch: t.createdBranch,
    kind: t.kind === 'chat' ? 'chat' : 'work',
    status: 'idle',
    createdAt,
    lastActivityAt: null,
    seenAt: null,
    summary: null,
    reviewUrl: t.reviewUrl ?? null,
    apiError: null,
    apiErrorText: null,
    spunFromTaskId: t.spunFromTaskId ?? null,
  };
}

export async function updateTask(id: number, patch: Partial<Task>): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const key of Object.keys(patch) as (keyof Task)[]) {
    if (key === 'id') continue; // never reassign the primary key
    const column = TASK_COLUMN[key];
    if (column === undefined) continue; // unknown field: ignore, do not inject
    // `undefined` means "not mentioned": spreading a partially-filled object
    // must not null out columns it never set. Explicit null still clears.
    if (patch[key] === undefined) continue;
    const value = patch[key];
    binds.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    sets.push(`${column} = $${binds.length}`);
  }
  if (sets.length === 0) return;
  binds.push(id);
  const db = await getDb();
  await db.execute(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${binds.length}`, binds);
  emitTasksChanged();
}

/**
 * Rename a task: its `title`, and nothing else (#152). The branch, the
 * worktree folder and the session id stay as they are; renaming the Claude
 * Code session too is ui/taskRename.ts's job, through the send gateway. The
 * caller cleans the title (`renamedTitle`); this only writes it.
 */
export async function renameTask(id: number, title: string): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE tasks SET title = $1 WHERE id = $2`, [title, id]);
  emitTasksChanged();
}

/**
 * A task's one-line summary (#262), or null to clear it: `tasks.summary` and
 * nothing else. Written by the session (src/ui/requestQueue.ts, from the MCP
 * inbox) and by the user (the rename field); the last write wins. The caller
 * cleans it (`cleanSummary` in ui/taskRename.ts, or the inbox's checks).
 * Resolves false when there is no such task.
 */
export async function setTaskSummary(id: number, summary: string | null): Promise<boolean> {
  const db = await getDb();
  const res = await db.execute(`UPDATE tasks SET summary = $1 WHERE id = $2`, [summary, id]);
  emitTasksChanged();
  return res.rowsAffected > 0;
}

/**
 * Delete a task AND its captured conversation.
 *
 * Claude Code's own transcript file is untouched, so the history is not lost
 * to the user -- only Albedo's copy goes. (This reverses the earlier
 * "conversation is kept" behaviour on purpose: the copy was growing without
 * bound, and a deleted task should not leave gigabytes behind.)
 *
 * ### What goes
 *
 * Every message for the task's session -- matched by `session_id`, not only
 * `task_id`, because subagent rows carry the PARENT's session id and are not
 * always tagged with the task -- plus any row still tagged with the task id.
 * The FTS index follows through the `messages_ad` trigger.
 *
 * ### The file record goes too
 *
 * The watcher holds a transcript only while it has a `transcript_files` row
 * (or a task owns its cwd). Removing the row is what makes the session
 * unheld, so it is not re-captured; it can be brought back from History,
 * which reads Claude Code's file again from byte 0.
 *
 * ### Order matters
 *
 * Foreign keys are NOT enforced (tauri-plugin-sql never issues
 * `PRAGMA foreign_keys = ON`), and there is no transaction here (the plugin
 * runs on a connection pool -- see insertMessages). Messages go FIRST, so a
 * failure between statements leaves the task present with fewer messages --
 * visible and retryable -- rather than a task row gone with its rows pointing
 * at nothing.
 */
export async function deleteTask(id: number): Promise<void> {
  await purgeTaskHistory(id);
  const db = await getDb();
  await db.execute(`DELETE FROM tasks WHERE id = $1`, [id]);
  emitTasksChanged();
}

/**
 * Remove Albedo's copy of a task's conversation and the watcher's record of
 * its transcript, keeping the task row. Exactly what {@link deleteTask} removes
 * besides the row itself, for the same reasons and in the same order.
 */
export async function purgeTaskHistory(id: number): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ session_id: string | null }[]>(
    `SELECT session_id FROM tasks WHERE id = $1`,
    [id],
  );
  const sessionId = rows[0]?.session_id ?? null;
  // The task row's own session, and any session its tagged messages belong to
  // (the row's session_id is only set once the task is adopted). The files
  // go first: they are looked up through the messages that are deleted next.
  await db.execute(
    `DELETE FROM transcript_files
      WHERE session_id = $2
         OR session_id IN (SELECT session_id FROM messages WHERE task_id = $1)`,
    [id, sessionId ?? ''],
  );
  try {
    await db.execute(
      `DELETE FROM messages
        WHERE session_id = $2
           OR session_id IN (SELECT session_id FROM messages WHERE task_id = $1)`,
      [id, sessionId ?? ''],
    );
    await db.execute(`DELETE FROM messages WHERE task_id = $1`, [id]);
  } finally {
    // Cached context peaks and usage hours hold only while rows are only added (#361, #365).
    forgetContextPeaks();
    forgetUsageHours();
  }
  // Review comments belong to the task and go with it: archived or deleted,
  // there is nothing left for them to be sent to.
  await db.execute(`DELETE FROM comments WHERE task_id = $1`, [id]);
  // Mockups a session showed for approval (#348): copies kept for viewing,
  // not raw_json, and nothing to answer once the task is gone.
  await db.execute(`DELETE FROM previews WHERE task_id = $1`, [id]);
}

/**
 * Archive a task and drop its captured conversation: an archived task is done,
 * and keeping its history is what grew the database without bound. Claude
 * Code's transcript stays on disk and can be brought back from History.
 *
 * The status flips FIRST. The watcher only adopts a cwd for a non-archived
 * task, so once the row reads archived nothing can re-hold the session between
 * the purge's statements and re-capture it from byte 0.
 */
export async function archiveTask(id: number): Promise<void> {
  const db = await getDb();
  // An archived task has stopped on nothing (#338): its error mark goes with it.
  await db.execute(`UPDATE tasks SET status = 'archived', api_error = NULL, api_error_text = NULL WHERE id = $1`, [id]);
  emitTasksChanged();
  await purgeTaskHistory(id);
}

/**
 * Startup housekeeping: purge history still held for archived tasks (archived
 * before archiving purged, or whose purge was interrupted), merge a fragmented
 * search index, then compact the file. auto_vacuum is off, so deleted rows only become free pages; VACUUM is
 * what gives the space back. It rewrites the file, so it runs only when at
 * least a quarter of it, and 8 MB, is free.
 */
export async function compactHistory(): Promise<void> {
  const db = await getDb();
  const archived = await db.select<{ id: number }[]>(
    `SELECT t.id FROM tasks t
      WHERE t.status = 'archived'
        AND (EXISTS (SELECT 1 FROM messages m WHERE m.task_id = t.id)
             OR (t.session_id IS NOT NULL
                 AND EXISTS (SELECT 1 FROM transcript_files f WHERE f.session_id = t.session_id)))`,
  );
  for (const { id } of archived) await purgeTaskHistory(id);

  // FTS5 keeps a tombstone per deleted row until segments merge, and many
  // small ingest batches leave many segments: measured at 77 MB of index for
  // 3 MB of text. 'optimize' merges it to one segment (~270 data rows on that
  // corpus, 1 s); the threshold keeps a healthy index from being rewritten
  // on every launch.
  const [fts] = await db.select<{ n: number }[]>(`SELECT count(*) AS n FROM messages_fts_data`);
  if ((fts?.n ?? 0) > 2000) {
    await db.execute(`INSERT INTO messages_fts(messages_fts) VALUES ('optimize')`);
  }

  const [pages] = await db.select<{ n: number }[]>(`SELECT page_count AS n FROM pragma_page_count()`);
  const [free] = await db.select<{ n: number }[]>(`SELECT freelist_count AS n FROM pragma_freelist_count()`);
  const [size] = await db.select<{ n: number }[]>(`SELECT page_size AS n FROM pragma_page_size()`);
  const freeBytes = (free?.n ?? 0) * (size?.n ?? 4096);
  if (pages && free && free.n * 4 >= pages.n && freeBytes >= 8 * 1024 * 1024) {
    await db.execute(`VACUUM`);
  }
}

/**
 * The task running in this folder.
 *
 * `ownedOnly` restricts it to worktrees Albedo cut for one task. Capture uses
 * only that form: a folder Albedo did not create -- above all the main
 * checkout -- is shared by every session anyone starts there, so it
 * identifies no task. See {@link findTaskBySessionId} for the exact link.
 */
export async function findTaskByWorktreePath(
  worktreePath: string,
  { liveOnly = false, ownedOnly = false }: { liveOnly?: boolean; ownedOnly?: boolean } = {},
): Promise<Task | null> {
  const db = await getDb();
  const live = liveOnly ? ` AND status != 'archived'` : '';
  const owned = ownedOnly ? ` AND owns_worktree != 0` : '';
  const rows = await db.select<TaskRow[]>(
    `SELECT ${TASK_SELECT} FROM tasks WHERE worktree_path = $1${live}${owned} ORDER BY id DESC LIMIT 1`,
    [worktreePath],
  );
  const row = rows[0];
  return row ? toTask(row) : null;
}

/**
 * The task whose session this is. Exact: Albedo chooses the id when it spawns
 * (`--session-id`), resumes it by that id, and follows `/clear` and `/resume`
 * through the SessionStart hook -- so this, not the folder, is how a
 * transcript finds its task.
 */
export async function findTaskBySessionId(
  sessionId: string,
  { liveOnly = false }: { liveOnly?: boolean } = {},
): Promise<Task | null> {
  if (!sessionId) return null;
  const db = await getDb();
  const live = liveOnly ? ` AND status != 'archived'` : '';
  const rows = await db.select<TaskRow[]>(
    `SELECT ${TASK_SELECT} FROM tasks WHERE session_id = $1${live} ORDER BY id DESC LIMIT 1`,
    [sessionId],
  );
  const row = rows[0];
  return row ? toTask(row) : null;
}

/**
 * Repair tasks whose base is their own branch -- what a task resumed from
 * History recorded until 2026-10-20. With base === branch every "what did
 * this task do" question answers "nothing" (an empty Files pane once the
 * branch is pushed) and the PR is never looked up. Each gets the repo's
 * default branch instead; a task genuinely on the default branch is left as
 * it is. The resolver is injected, as for backfillProjectsFromTasks: the db
 * layer does not spawn git. Returns how many rows changed.
 */
export async function repairSelfBasedTasks(
  defaultBranchOf: (repoPath: string) => Promise<string | null>,
): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ id: number; repo_path: string; branch: string }[]>(
    `SELECT id, repo_path, branch FROM tasks
      WHERE status != 'archived' AND branch != '' AND base_branch = branch`,
  );
  let changed = 0;
  for (const r of rows) {
    const base = await defaultBranchOf(r.repo_path).catch(() => null);
    if (!base || base === r.branch) continue;
    await db.execute(`UPDATE tasks SET base_branch = $1 WHERE id = $2 AND base_branch = branch`, [base, r.id]);
    changed += 1;
  }
  if (changed > 0) emitTasksChanged();
  return changed;
}

/** Whether Albedo holds a transcript file for this session. */
export async function hasTranscriptForSession(sessionId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM transcript_files WHERE session_id = $1`,
    [sessionId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * Record that a task's session produced activity. `last_activity_at` only ever
 * moves forward, so replaying an old file during backfill cannot rewrite a
 * live task's recency.
 *
 * It never changes which session the task is on. It used to, and that was the
 * restart bug: every session ingested from a shared folder overwrote the
 * task's id, so a restart resumed whichever file happened to be read last.
 * The session changes only through `linkTaskSession` (capture/sessionLink.ts).
 *
 * Listeners hear about it only when the row actually changed: every ingest
 * chunk lands here, and a no-op touch used to cost every subscriber a full
 * task reload. Returns whether it changed.
 */
export async function touchTaskActivity(taskId: number, ts: number): Promise<boolean> {
  const db = await getDb();
  const res = await db.execute(
    `UPDATE tasks
        SET last_activity_at = $1
      WHERE id = $2
        AND COALESCE(last_activity_at, 0) < $1`,
    [ts, taskId],
  );
  // A driver that does not report a count is treated as "changed": a missed
  // notification is a stale list, an extra one is only a reload.
  const changed = typeof res?.rowsAffected === 'number' ? res.rowsAffected > 0 : true;
  if (changed) emitTasksChanged();
  return changed;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const DEFAULT_MESSAGE_LIMIT = 5000;

export interface GetMessagesOptions {
  taskId?: number;
  sessionId?: string;
  afterSeq?: number;
  /**
   * Only rows inserted after this id: "what is new since I last looked",
   * across every file of the session at once. Ingest assigns ids in insertion
   * order, so unlike `seq` it is one numbering for the parent and all its
   * subagents. Pages forward like `afterSeq`, ordered by id.
   */
  afterId?: number;
  limit?: number;
  /**
   * Only the session's own conversation, not its subagents' rows. Subagent
   * rows are stored under the PARENT's session id, so a status derived from the
   * whole session reads a subagent's in-flight tool call as the parent waiting
   * on a permission prompt.
   */
  parentOnly?: boolean;
  /**
   * Only the rows ONE subagent wrote -- what the subagent inspector reads. The
   * counterpart of `parentOnly`, and it wins over it: asking for an agent's
   * rows and for "no agent" at once has no useful answer.
   *
   * Pair it with `sessionId` (the PARENT's, which is where subagent rows are
   * stored). That makes the query seq-ordered, and `seq` is file-local -- one
   * agent is one file, so its seqs are a consistent order and `afterSeq`
   * pages forward through them exactly as it does for a parent session.
   */
  agentId?: string;
}

/**
 * Sort keys getMessages uses, in precedence order.
 *
 * Within one session `seq` is exact, cheap, and what `afterSeq` pages on, so
 * it leads. For anything task-scoped `ts` has to lead: a task RESUMED into a
 * new transcript file starts its seq back at 0, so a seq-ordered task query
 * would interleave the resumed session with the old one in the pane.
 */
export function messageOrderKeys(opts: GetMessagesOptions): string[] {
  // Paging on id must also be ordered by id, or a forward page could skip
  // rows between the cursor and the page's first row.
  if (opts.afterId !== undefined) return ['id'];
  const seqScoped = opts.taskId === undefined && opts.sessionId !== undefined;
  return seqScoped ? ['seq', 'ts', 'id'] : ['ts', 'seq', 'id'];
}

/**
 * The ORDER BY getMessages sends: {@link messageOrderKeys}, minus the
 * tiebreakers that can never decide.
 *
 * A parent-only read of one session pins (session_id, COALESCE(agent_id, ''))
 * and messages_session_seq is UNIQUE on those plus seq, so no two rows share a
 * seq and `ts, id` after it never break a tie. Dropping them gives the same
 * order, and lets SQLite read the index in order instead of sorting.
 */
function sqlOrderKeys(opts: GetMessagesOptions): string[] {
  const keys = messageOrderKeys(opts);
  const oneParentFile = opts.parentOnly === true && opts.agentId === undefined;
  return oneParentFile && keys[0] === 'seq' ? ['seq'] : keys;
}

/** Which end of the result set `limit` truncates. */
export type PageDirection = 'head' | 'tail';

/**
 * `limit` semantics depend on which way the caller is paging:
 *
 *   no cursor        -> 'tail', keep the MOST RECENT rows. deriveStatus needs
 *                       this; fed the oldest 400 rows of a long session it
 *                       would report a stale status forever.
 *   afterSeq/afterId -> 'head', keep the OLDEST rows after the cursor. The
 *                       caller is paging FORWARD and will append the page to
 *                       what it already holds.
 *
 * Why the split exists: with 'tail' semantics a forward page that came back
 * full silently meant rows between `afterSeq` and the start of that page had
 * been dropped, and appending it spliced a hole into the middle of the
 * transcript -- a defect that surfaces as a rendering bug nowhere near its
 * cause. Under 'head' semantics a forward page is contiguous by construction,
 * whatever limit the caller picks. Both directions return rows ascending.
 */
export function messagePageDirection(opts: GetMessagesOptions): PageDirection {
  return opts.afterSeq === undefined && opts.afterId === undefined ? 'tail' : 'head';
}

export async function getMessages(opts: GetMessagesOptions): Promise<Message[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.taskId !== undefined) {
    binds.push(opts.taskId);
    where.push(`task_id = $${binds.length}`);
  }
  if (opts.sessionId !== undefined) {
    binds.push(opts.sessionId);
    where.push(`session_id = $${binds.length}`);
  }
  if (opts.agentId !== undefined) {
    binds.push(opts.agentId);
    where.push(`agent_id = $${binds.length}`);
  } else if (opts.parentOnly) {
    // Unary + keeps SQLite off messages_agent, a worse plan for this query;
    // messages_session_seq is ~10x faster on a long session (110 ms -> 10 ms measured).
    where.push('+agent_id IS NULL');
    // The same rows (agent_id is NULL exactly when COALESCE(agent_id, '') is
    // '' and agent_id IS NULL both hold), but it names messages_session_seq's
    // second column, so a session-scoped read walks that index in seq order
    // instead of sorting the whole session -- raw_json included -- to keep 400
    // rows (60 ms -> 0.7 ms on a 20,000-row session, #361).
    where.push(`COALESCE(agent_id, '') = ''`);
  }
  if (opts.afterSeq !== undefined) {
    // exclusive: pages forward from the last seq the caller already has
    binds.push(opts.afterSeq);
    where.push(`seq > $${binds.length}`);
  }
  if (opts.afterId !== undefined) {
    binds.push(opts.afterId);
    where.push(`id > $${binds.length}`);
  }
  binds.push(Math.max(1, opts.limit ?? DEFAULT_MESSAGE_LIMIT));

  const keys = sqlOrderKeys(opts);
  const ascending = keys.map((k) => `${k} ASC`).join(', ');
  const descending = keys.map((k) => `${k} DESC`).join(', ');
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  // Forward paging: take the OLDEST rows after `afterSeq`, already ascending,
  // so consecutive pages abut and cannot leave a gap.
  // Otherwise: take the tail, which needs an inner DESC + LIMIT and an outer
  // re-sort to come back ascending.
  const sql =
    messagePageDirection(opts) === 'head'
      ? `SELECT ${MESSAGE_SELECT} FROM messages ${whereSql} ORDER BY ${ascending} LIMIT $${binds.length}`
      : `SELECT * FROM ( SELECT ${MESSAGE_SELECT} FROM messages ${whereSql} ORDER BY ${descending} LIMIT $${binds.length} ) ORDER BY ${ascending}`;

  const db = await getDb();
  const rows = await db.select<MessageRow[]>(sql, binds);
  return rows.map(toMessage);
}

/**
 * Tool results of one tool whose raw line contains `needle`, newest first.
 * A scan: for a lookup made once per row on screen, not per keystroke.
 * `instr`, not LIKE, so a needle needs no escaping.
 */
export async function findToolResults(toolName: string, needle: string, limit = 5): Promise<Message[]> {
  const db = await getDb();
  const rows = await db.select<MessageRow[]>(
    `SELECT ${MESSAGE_SELECT} FROM messages
      WHERE role = 'tool_result' AND tool_name = $1 AND instr(raw_json, $2) > 0
      ORDER BY id DESC LIMIT $3`,
    [toolName, needle, Math.max(1, limit)],
  );
  return rows.map(toMessage);
}

/**
 * The claude.ai link of the newest "Remote Control is active" row in the
 * session written at or after `sinceTs`, with the row's time for weighing it
 * against newer facts, or null. The caller passes when its pty was spawned: a
 * row from before that describes a process that is gone.
 */
export async function remoteControlLineSince(
  sessionId: string,
  sinceTs: number,
): Promise<{ url: string; ts: number } | null> {
  const db = await getDb();
  const rows = await db.select<{ raw_json: string; ts: number }[]>(
    `SELECT raw_json, ts FROM messages
      WHERE session_id = $1 AND ts >= $2 AND role = 'system' AND +agent_id IS NULL
        AND ${remoteControlSqlPredicate('raw_json')}
      ORDER BY ts DESC, id DESC LIMIT 10`,
    [sessionId, sinceTs],
  );
  for (const row of rows) {
    const url = remoteControlUrlOf(row.raw_json);
    if (url !== null) return { url, ts: row.ts };
  }
  return null;
}

/** Most preselected rows a background lookup reads; the newest win. */
const BACKGROUND_ROWS_MAX = 1000;
/** Most calls or results a background lookup fetches the other half of. */
const BACKGROUND_PAIRS_MAX = 50;

/**
 * The session's main-thread rows written at or after `sinceTs` that may
 * start, end or stop background work, oldest first, for
 * `runningInBackground` (capture/background.ts). The caller passes when its
 * pty was spawned: the work dies with the process, so nothing from before it
 * can still run.
 *
 * Two reads. The first takes what `backgroundSqlPredicate` preselects. Some
 * starts show on one half only -- an agent async by default has no flag on
 * its call, a shell moved to the background by its timeout neither -- so the
 * second fetches the other half of every call or result found alone, by its
 * tool-use id.
 */
export async function backgroundRowsSince(sessionId: string, sinceTs: number): Promise<Message[]> {
  const db = await getDb();
  const first = await db.select<MessageRow[]>(
    `SELECT ${MESSAGE_SELECT} FROM messages
      WHERE session_id = $1 AND ts >= $2 AND +agent_id IS NULL AND ${backgroundSqlPredicate()}
      ORDER BY ts DESC, id DESC LIMIT $3`,
    [sessionId, sinceTs, BACKGROUND_ROWS_MAX],
  );
  const rows = (first ?? []).map(toMessage);

  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of rows) {
    for (const f of backgroundFactsOf(m)) {
      if (f.fact === 'call') calls.add(f.toolUseId);
      else if (f.fact === 'result') results.add(f.toolUseId);
    }
  }
  const alone = [...calls].filter((id) => !results.has(id)).concat([...results].filter((id) => !calls.has(id)));
  const ids = alone.slice(0, BACKGROUND_PAIRS_MAX);
  if (ids.length > 0) {
    const needles = ids.map((_, i) => `instr(raw_json, $${i + 3}) > 0`).join(' OR ');
    const second = await db.select<MessageRow[]>(
      `SELECT ${MESSAGE_SELECT} FROM messages
        WHERE session_id = $1 AND ts >= $2 AND +agent_id IS NULL AND role IN ('tool_use', 'tool_result')
          AND (${needles})`,
      [sessionId, sinceTs, ...ids.map((id) => `"${id}"`)],
    );
    const held = new Set(rows.map((m) => m.id));
    for (const m of (second ?? []).map(toMessage)) if (!held.has(m.id)) rows.push(m);
  }
  return rows.sort((a, b) => a.ts - b.ts || a.id - b.id);
}

/** A parsed row plus the task it was adopted by (null for terminal sessions). */
export type InsertableMessage = ParsedMessage & { taskId: number | null };

const MESSAGE_INSERT_COLUMNS = [
  'task_id',
  'session_id',
  'seq',
  'role',
  'tool_name',
  'target_path',
  'body',
  'raw_json',
  'agent_id',
  'ts',
] as const;

const INSERT_CHUNK_ROWS = Math.max(1, Math.floor(MAX_BIND_PARAMS / MESSAGE_INSERT_COLUMNS.length));

/**
 * Batched, idempotent insert.
 *
 * First import is thousands of rows; one round-trip per row through the Tauri
 * IPC bridge would take minutes. Rows go out as multi-row INSERTs of
 * INSERT_CHUNK_ROWS at a time.
 *
 * `INSERT OR IGNORE` against the messages_session_seq unique index makes
 * re-ingesting a byte range a no-op, so a crash mid-file costs nothing.
 *
 * Deliberately no explicit BEGIN/COMMIT: tauri-plugin-sql runs queries on a
 * sqlx connection POOL, so a transaction opened by one `execute` is not
 * guaranteed to be the connection the next one lands on. Each multi-row
 * INSERT is a single statement and therefore already atomic, which is the
 * property that actually matters here.
 *
 * @returns number of rows actually written (duplicates excluded).
 */
export async function insertMessages(rows: InsertableMessage[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  let written = 0;
  for (const batch of buildMessageInsertBatches(rows)) {
    const res = await db.execute(batch.sql, batch.binds);
    written += res.rowsAffected;
  }
  return written;
}

export interface InsertBatch {
  sql: string;
  binds: unknown[];
}

/**
 * Split rows into multi-row INSERT statements. Pure, and exported, because a
 * one-off error in the `$n` numbering would shift every column of every row on
 * first import -- silently, since the types all still match.
 */
export function buildMessageInsertBatches(rows: InsertableMessage[]): InsertBatch[] {
  const columns = MESSAGE_INSERT_COLUMNS.join(', ');
  const batches: InsertBatch[] = [];

  for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
    const chunk = rows.slice(start, start + INSERT_CHUNK_ROWS);
    const binds: unknown[] = [];
    const tuples: string[] = [];
    for (const r of chunk) {
      const slots: string[] = [];
      // Order MUST match MESSAGE_INSERT_COLUMNS.
      for (const value of [
        r.taskId,
        r.sessionId,
        r.seq,
        r.role,
        r.toolName,
        r.targetPath,
        r.body,
        r.rawJson,
        r.agentId,
        r.ts,
      ]) {
        binds.push(value);
        slots.push(`$${binds.length}`);
      }
      tuples.push(`(${slots.join(', ')})`);
    }
    batches.push({
      sql: `INSERT OR IGNORE INTO messages (${columns}) VALUES ${tuples.join(', ')}`,
      binds,
    });
  }
  return batches;
}

/** Rows per multi-row INSERT. Exported so tests can reason about batching. */
export const MESSAGE_INSERT_CHUNK_ROWS = INSERT_CHUNK_ROWS;

/**
 * Backfill `task_id` on rows captured before a task existed (a session started
 * in a plain terminal that is later adopted by a task).
 */
export async function adoptSessionIntoTask(sessionId: string, taskId: number): Promise<void> {
  const db = await getDb();
  // Rows held by an archived task are free too: archiving keeps the task row,
  // so a session imported back from History may have been tagged with it.
  await db.execute(
    `UPDATE messages SET task_id = $1
      WHERE session_id = $2
        AND (task_id IS NULL OR task_id IN (SELECT id FROM tasks WHERE status = 'archived'))`,
    [taskId, sessionId],
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Turn arbitrary user input into a query FTS5 will accept.
 *
 * FTS5 has real syntax (AND/OR/NOT/NEAR, `:`, `^`, `-`, parentheses); a stray
 * apostrophe or colon in a search box otherwise raises "fts5: syntax error".
 * Every whitespace-separated term is wrapped in double quotes, which makes
 * FTS5 treat its contents as a literal phrase — the only character that stays
 * special inside quotes is `"` itself, which is escaped by doubling.
 *
 * A trailing `*` is kept outside the quotes so prefix search still works.
 * Terms with no letter or digit are dropped: `"---"` matches no token and
 * would silently zero out the whole (implicitly AND-ed) query.
 *
 * @returns null when nothing searchable remains.
 */
export function toFtsQuery(query: string): string | null {
  const terms: string[] = [];
  for (const rawTerm of query.split(/\s+/)) {
    if (rawTerm.length === 0) continue;
    const prefix = rawTerm.endsWith('*');
    const stem = prefix ? rawTerm.slice(0, -1) : rawTerm;
    if (!/[\p{L}\p{N}]/u.test(stem)) continue;
    terms.push(`"${stem.replace(/"/g, '""')}"${prefix ? '*' : ''}`);
  }
  return terms.length === 0 ? null : terms.join(' ');
}

// ---------------------------------------------------------------------------
// transcript_files — watcher bookkeeping
// ---------------------------------------------------------------------------

export interface TranscriptFileRecord {
  path: string;
  sessionId: string;
  projectDir: string;
  cwd: string | null;
  /** Session title from an `ai-title` / `custom-title` line, if one appeared. */
  title: string | null;
  /** Byte offset of the first byte NOT yet ingested. Always a line boundary. */
  bytesIngested: number;
  /**
   * Watermark: every seq up to and including this value has been considered.
   * Stored as `lastLineIndex * SEQ_STRIDE + (SEQ_STRIDE - 1)` so the next
   * chunk's starting line index is recoverable even when the trailing lines
   * were bookkeeping types that produced no rows. -1 means "nothing ingested".
   */
  lastSeq: number;
  mtime: number | null;
  updatedAt: number;
}

interface TranscriptFileRow {
  path: string;
  session_id: string;
  project_dir: string;
  cwd: string | null;
  title: string | null;
  bytes_ingested: number;
  last_seq: number;
  mtime: number | null;
  updated_at: number;
}

const TRANSCRIPT_SELECT =
  'path, session_id, project_dir, cwd, title, bytes_ingested, last_seq, mtime, updated_at';

function toTranscriptFile(r: TranscriptFileRow): TranscriptFileRecord {
  return {
    path: r.path,
    sessionId: r.session_id,
    projectDir: r.project_dir,
    cwd: r.cwd,
    // '' is an internal sentinel meaning "scanned for a title, found none",
    // which is what stops the one-time backfill re-reading a titleless file on
    // every launch. Callers only ever see `string | null`.
    title: r.title === null || r.title.length === 0 ? null : r.title,
    bytesIngested: r.bytes_ingested,
    lastSeq: r.last_seq,
    mtime: r.mtime,
    updatedAt: r.updated_at,
  };
}

export async function getTranscriptFile(path: string): Promise<TranscriptFileRecord | null> {
  const db = await getDb();
  const rows = await db.select<TranscriptFileRow[]>(
    `SELECT ${TRANSCRIPT_SELECT} FROM transcript_files WHERE path = $1`,
    [path],
  );
  const row = rows[0];
  return row ? toTranscriptFile(row) : null;
}

export async function listTranscriptFiles(): Promise<TranscriptFileRecord[]> {
  const db = await getDb();
  const rows = await db.select<TranscriptFileRow[]>(
    `SELECT ${TRANSCRIPT_SELECT} FROM transcript_files ORDER BY COALESCE(mtime, 0) DESC`,
  );
  return rows.map(toTranscriptFile);
}

export async function upsertTranscriptFile(
  rec: Omit<TranscriptFileRecord, 'updatedAt'>,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO transcript_files (path, session_id, project_dir, cwd, title, bytes_ingested, last_seq, mtime, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(path) DO UPDATE SET
       session_id     = excluded.session_id,
       project_dir    = excluded.project_dir,
       cwd            = COALESCE(excluded.cwd, transcript_files.cwd),
       -- a chunk carrying no title must not erase one seen earlier
       title          = COALESCE(excluded.title, transcript_files.title),
       bytes_ingested = excluded.bytes_ingested,
       last_seq       = excluded.last_seq,
       mtime          = excluded.mtime,
       updated_at     = excluded.updated_at`,
    [
      rec.path,
      rec.sessionId,
      rec.projectDir,
      rec.cwd,
      rec.title,
      rec.bytesIngested,
      rec.lastSeq,
      rec.mtime,
      Date.now(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Rows derived from assistant LINES within a time window. Both `assistant` and
 * `tool_use` roles come from assistant lines, and a line that emitted only
 * tool calls carries usage too — querying `role = 'assistant'` alone would
 * undercount. De-duplication per line is the caller's job (see usage.ts).
 */
export async function getAssistantRowsSince(
  sinceTs: number,
  untilTs?: number,
): Promise<Pick<Message, 'sessionId' | 'seq' | 'rawJson' | 'ts'>[]> {
  const db = await getDb();
  const rows = await db.select<Pick<MessageRow, 'session_id' | 'seq' | 'raw_json' | 'ts'>[]>(
    `SELECT session_id, seq, raw_json, ts
       FROM messages
      WHERE ts >= $1 ${untilTs === undefined ? '' : 'AND ts <= $2'}
        AND role IN ('assistant', 'tool_use')
      ORDER BY ts ASC`,
    untilTs === undefined ? [sinceTs] : [sinceTs, untilTs],
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    seq: r.seq,
    rawJson: r.raw_json,
    ts: r.ts,
  }));
}

// ---------------------------------------------------------------------------
// Per-session context window
// ---------------------------------------------------------------------------

/**
 * Sessions per query. Each is bound twice (its id and its peak cursor), so
 * this stays well inside MAX_BIND_PARAMS.
 */
const CONTEXT_SESSION_CHUNK = 400;

/**
 * The rows of a session's OWN conversation: not its subagents', which are
 * stored under the parent's session id with their own seq numbering (one file
 * each). Both terms together select exactly the rows `agent_id IS NULL`
 * does; the COALESCE names messages_session_seq's second column so SQLite
 * walks that index, and the unary + keeps it off messages_agent, which would
 * fetch every row of the session from the table to filter it.
 */
const PARENT_ROWS_SQL = `COALESCE(agent_id, '') = '' AND +agent_id IS NULL`;

/**
 * Peak context occupancy per session, and the highest message id it covers.
 *
 * A peak only grows while rows are only added, so each read scans just the
 * rows inserted since the last one (ids are assigned in insertion order) and
 * folds them in. Recomputing it from every row after each burst of appends
 * cost ~30 ms on a 20,000-row session (#361).
 *
 * Rows being deleted is the one thing that lowers a peak, or lets SQLite hand
 * out an id below a cursor again. The only code that deletes messages is
 * purgeTaskHistory (deleteTask goes through it), and it calls
 * {@link forgetContextPeaks}. The other writes cannot lower a peak: inserts
 * are INSERT OR IGNORE (never a rewrite), adoptSessionIntoTask changes only
 * task_id (the peak reads none), nothing ever changes a row's session_id or
 * raw_json, and the migrations that delete run before the app reads.
 * Anything new that deletes or rewrites messages must call it too.
 */
const contextPeaks = new Map<string, { peak: number; lastId: number }>();
/** Bumped by every forget, so a read that began before it cannot write back. */
let contextPeakGeneration = 0;

/** Drop every cached peak; the next read recomputes from all rows. */
export function forgetContextPeaks(): void {
  contextPeaks.clear();
  contextPeakGeneration++;
}

export interface SessionContextRow {
  sessionId: string;
  /** Highest context occupancy seen anywhere in the session's own rows. */
  peakUsed: number;
  /** raw_json of the newest line carrying a usage record. */
  latestRawJson: string | null;
  latestTs: number | null;
}

/**
 * Peak and latest context occupancy for many sessions in ONE query per chunk,
 * not one per session -- the task list calls this on every refresh.
 *
 * The summing happens in SQLite rather than in TypeScript on purpose: the
 * alternative is shipping every assistant line's raw_json across the IPC
 * bridge just to pick a denominator, which for a long session is megabytes.
 *
 * Only the session's own rows count (#361). A subagent's rows share the
 * session id, and its seq is numbered in its own file: a long Explore agent
 * had the highest seq, so the meter showed its context and its model, and a
 * resume could pick that model up through lastModelOf.
 *
 * "Latest" is the parent row with the highest seq that carries a usage record,
 * read off the end of messages_session_seq; seq is unique among a session's
 * parent rows, so it is one row. The peak is folded in from the rows added
 * since the last read (see {@link contextPeaks}). Both come from one
 * statement, so they describe the same moment.
 */
export async function getSessionContextRows(
  sessionIds: string[],
): Promise<SessionContextRow[]> {
  if (sessionIds.length === 0) return [];
  const db = await getDb();
  const usedExpr = contextUsedSqlExpr('m.raw_json');
  const out: SessionContextRow[] = [];

  for (let start = 0; start < sessionIds.length; start += CONTEXT_SESSION_CHUNK) {
    const chunk = [...new Set(sessionIds.slice(start, start + CONTEXT_SESSION_CHUNK))];
    // Read again if the cache was forgotten while the statement ran: its
    // cursors then predate a delete, and folding its rows into an emptied
    // cache would understate the peak.
    for (;;) {
      const generation = contextPeakGeneration;
      const held = new Map(chunk.map((id) => [id, contextPeaks.get(id)]));
      const binds: unknown[] = [];
      const values = chunk
        .map((id) => {
          binds.push(id, held.get(id)?.lastId ?? -1);
          return `($${binds.length - 1}, $${binds.length})`;
        })
        .join(', ');
      const rows = await db.select<
        {
          session_id: string;
          latest_ts: number | null;
          latest_raw: string | null;
          peak_used: number | null;
          peak_last_id: number | null;
        }[]
      >(
        // Scalar subqueries, not a join grouped by session: GROUP BY over a
        // join sorted every joined row, raw_json and all, through a temp
        // b-tree (~20x slower than the scan itself, measured).
        `WITH c(sid, cursor_id) AS (VALUES ${values})
         SELECT c.sid      AS session_id,
                l.ts       AS latest_ts,
                l.raw_json AS latest_raw,
                (SELECT MAX(${usedExpr}) FROM messages m
                  WHERE m.session_id = c.sid
                    AND COALESCE(m.agent_id, '') = '' AND +m.agent_id IS NULL
                    -- Unary +: as a rowid range, a cursor of -1 would walk the
                    -- whole table instead of the session's index range.
                    AND +m.id > c.cursor_id
                    AND m.role IN ('assistant', 'tool_use')) AS peak_used,
                -- Where the next read resumes. Every row up to it was in reach
                -- of peak_used above (same statement, same snapshot); taking it
                -- over more rows than the peak reads is harmless, and lets the
                -- index answer it alone.
                (SELECT MAX(id) FROM messages
                  WHERE session_id = c.sid AND COALESCE(agent_id, '') = '') AS peak_last_id
           FROM c
           JOIN messages l ON l.id = (
                  SELECT id FROM messages
                   WHERE session_id = c.sid AND ${PARENT_ROWS_SQL}
                     AND role IN ('assistant', 'tool_use')
                     AND json_extract(raw_json, '${USAGE_PRESENCE_JSON_PATH}') IS NOT NULL
                   ORDER BY seq DESC LIMIT 1)`,
        binds,
      );
      if (generation !== contextPeakGeneration) continue;
      const byId = new Map(rows.map((r) => [r.session_id, r]));
      for (const id of chunk) {
        const r = byId.get(id);
        // The peak of the rows read now, folded into what the cursor covered.
        const peak = Math.max(held.get(id)?.peak ?? 0, r?.peak_used ?? 0);
        if (r?.peak_last_id != null) {
          // Merged, not replaced: another read may have landed meanwhile. Each
          // covers every row up to its own lastId, so the union is the larger.
          const now = contextPeaks.get(id);
          contextPeaks.set(id, {
            peak: Math.max(peak, now?.peak ?? 0),
            lastId: Math.max(r.peak_last_id, now?.lastId ?? -1),
          });
        }
        if (r === undefined) continue;
        out.push({
          sessionId: id,
          peakUsed: peak,
          latestRawJson: r.latest_raw,
          latestTs: r.latest_ts,
        });
      }
      break;
    }
  }
  return out;
}

/**
 * Fallback source for context derivation: the raw assistant rows themselves.
 *
 * Used when getSessionContextRows fails, which in practice means a SQLite
 * build without the JSON1 functions. Costs far more bandwidth, so it is not
 * the primary path, but it keeps the feature working rather than blanking it.
 * The session's own rows only, as in getSessionContextRows; a subagent's seq
 * would also collide with the parent's in aggregateUsageRows' per-line keys.
 */
export async function getSessionUsageRows(
  sessionIds: string[],
): Promise<Pick<Message, 'sessionId' | 'seq' | 'rawJson' | 'ts'>[]> {
  if (sessionIds.length === 0) return [];
  const out: Pick<Message, 'sessionId' | 'seq' | 'rawJson' | 'ts'>[] = [];
  const db = await getDb();

  for (let start = 0; start < sessionIds.length; start += CONTEXT_SESSION_CHUNK) {
    const chunk = sessionIds.slice(start, start + CONTEXT_SESSION_CHUNK);
    const slots = chunk.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await db.select<
      Pick<MessageRow, 'session_id' | 'seq' | 'raw_json' | 'ts'>[]
    >(
      `SELECT session_id, seq, raw_json, ts
         FROM messages
        WHERE session_id IN (${slots}) AND ${PARENT_ROWS_SQL}
          AND role IN ('assistant', 'tool_use')
        ORDER BY session_id ASC, seq ASC`,
      chunk,
    );
    for (const r of rows) {
      out.push({ sessionId: r.session_id, seq: r.seq, rawJson: r.raw_json, ts: r.ts });
    }
  }
  return out;
}

/**
 * Token totals over a time window, across ALL sessions -- the subscription
 * quota is account-wide, which is the entire reason the header exists.
 *
 * Aggregated in SQLite, and de-duplicated per LINE inside the query: usage
 * belongs to the JSONL line, but a line expands into several rows sharing one
 * raw_json, so the inner GROUP BY collapses them by (session_id, line index)
 * before anything is summed. Without it a turn that emitted thinking, text and
 * two tool calls would be billed four times.
 */
export interface WindowUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Assistant turns counted. */
  lineCount: number;
  /** ts of the oldest counted turn, or null when the window is empty. */
  oldestTs: number | null;
}

/**
 * {@link getWindowUsageTotals} in one query over the whole window: what the
 * cached path must equal, and what it falls back to.
 */
export async function getWindowUsageTotalsExact(
  startTs: number,
  endTs: number,
): Promise<WindowUsageTotals> {
  const db = await getDb();
  const rows = await db.select<
    {
      input_tokens: number | null;
      output_tokens: number | null;
      cache_creation_input_tokens: number | null;
      cache_read_input_tokens: number | null;
      line_count: number | null;
      oldest_ts: number | null;
    }[]
  >(
    `SELECT COALESCE(SUM(in_t), 0)     AS input_tokens,
            COALESCE(SUM(out_t), 0)    AS output_tokens,
            COALESCE(SUM(cc_t), 0)     AS cache_creation_input_tokens,
            COALESCE(SUM(cr_t), 0)     AS cache_read_input_tokens,
            COUNT(*)                   AS line_count,
            MIN(line_ts)               AS oldest_ts
       FROM (
         SELECT MAX(${usageSqlExpr('inputTokens')})             AS in_t,
                MAX(${usageSqlExpr('outputTokens')})            AS out_t,
                MAX(${usageSqlExpr('cacheCreationInputTokens')}) AS cc_t,
                MAX(${usageSqlExpr('cacheReadInputTokens')})     AS cr_t,
                MIN(ts) AS line_ts
           FROM messages
          WHERE ts >= $1 AND ts <= $2
            AND role IN ('assistant', 'tool_use')
            AND json_extract(raw_json, '${USAGE_PRESENCE_JSON_PATH}') IS NOT NULL
          GROUP BY session_id, seq / ${SEQ_STRIDE}
       )`,
    [startTs, endTs],
  );
  const r = rows[0];
  return {
    inputTokens: r?.input_tokens ?? 0,
    outputTokens: r?.output_tokens ?? 0,
    cacheCreationInputTokens: r?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: r?.cache_read_input_tokens ?? 0,
    lineCount: r?.line_count ?? 0,
    oldestTs: r?.oldest_ts ?? null,
  };
}

// ---------------------------------------------------------------------------
// Window usage with the closed hours cached (#365)
// ---------------------------------------------------------------------------
//
// The status strip asks for seven days every 30 s, and the query reads every
// usage line of the week (~630 ms on the owner's data). Hours that are over
// do not change while rows are only added, so their per-line maxima are kept
// and only the new rows, the open hour and the window's first, partial hour
// are read again.
//
// Exactly the same answer as the one query, which is pinned in a test. The
// query groups rows by (session, line) and takes each counter's MAX and the
// MIN ts per group, then sums. A group's rows can lie in different hours --
// a subagent's lines share the parent's session and line numbers, measured
// on the owner's data at 6,814 groups over 11,107 group-hours in a week -- so
// hours are never summed on their own: the cache keeps each hour's per-group
// maxima, and the groups are merged across the pieces (MAX of MAXes, MIN of
// MINs) before anything is summed. MAX and MIN do not care how often a row
// is seen, so a row folded in twice changes nothing; one never folded in
// would, and the id cursor is what makes sure none is missed.
//
// Valid while rows are only added, as for the context peaks above: the only
// code that deletes messages is purgeTaskHistory, and it (and resetDb) call
// forgetUsageHours. Ids are assigned in insertion order, so the rows added
// since the last read are those past the cursor.

const HOUR_MS = 3_600_000;
/** Windows shorter than this are read in one query: there is no closed hour worth keeping. */
const CACHE_MIN_SPAN_MS = 2 * HOUR_MS;
/** Hours older than this before the window's end are let go. */
const CACHE_KEEP_MS = 8 * 24 * HOUR_MS;

interface LineMax {
  inT: number;
  outT: number;
  ccT: number;
  crT: number;
  minTs: number;
}

interface UsageHours {
  /** Hour start -> group key -> that group's maxima over its rows in the hour. */
  hours: Map<number, Map<string, LineMax>>;
  /** Every row with an id up to this is in the hours held. -1: none read yet. */
  lastId: number;
}

let usageHours: UsageHours = { hours: new Map(), lastId: -1 };
let usageCacheOn = true;

/**
 * Tests that script the SQL by hand expect the one query; this turns the
 * cache off for them. The cache itself is pinned against the one query on a
 * real SQLite (usageHours.test.ts).
 */
export function setUsageHourCacheForTests(on: boolean): void {
  usageCacheOn = on;
  forgetUsageHours();
}
let usageChain: Promise<unknown> = Promise.resolve();
let messageDeletionCount = 0;

/** Drop the cached hours; the next read starts over. Called wherever messages are deleted. */
export function forgetUsageHours(): void {
  usageHours = { hours: new Map(), lastId: -1 };
  messageDeletionCount++;
}

/** Bumped whenever messages may have been deleted: a usage figure read before it may be too high. */
export function messageDeletions(): number {
  return messageDeletionCount;
}

function mergeLine(into: Map<string, LineMax>, key: string, m: LineMax): void {
  const had = into.get(key);
  if (!had) {
    into.set(key, { ...m });
    return;
  }
  had.inT = Math.max(had.inT, m.inT);
  had.outT = Math.max(had.outT, m.outT);
  had.ccT = Math.max(had.ccT, m.ccT);
  had.crT = Math.max(had.crT, m.crT);
  had.minTs = Math.min(had.minTs, m.minTs);
}

interface LineRow {
  session_id: string;
  line: number;
  in_t: number | null;
  out_t: number | null;
  cc_t: number | null;
  cr_t: number | null;
  min_ts: number;
}

/**
 * Per-(group, hour) maxima of the usage lines with `from <= ts < to` (or
 * `<= to` when `toInclusive`), optionally only ids in `(idAfter, idUpTo]`.
 * The same row filter and the same expressions as the one query.
 */
async function usageLines(
  from: number,
  to: number,
  opts: { toInclusive?: boolean; idAfter?: number; idUpTo?: number } = {},
): Promise<Array<{ key: string; m: LineMax }>> {
  const db = await getDb();
  const params: number[] = [from, to];
  let ids = '';
  if (opts.idAfter !== undefined) {
    params.push(opts.idAfter);
    ids += ` AND id > $${params.length}`;
  }
  if (opts.idUpTo !== undefined) {
    params.push(opts.idUpTo);
    ids += ` AND id <= $${params.length}`;
  }
  const rows = await db.select<LineRow[]>(
    `SELECT session_id,
            seq / ${SEQ_STRIDE} AS line,
            MAX(${usageSqlExpr('inputTokens')})             AS in_t,
            MAX(${usageSqlExpr('outputTokens')})            AS out_t,
            MAX(${usageSqlExpr('cacheCreationInputTokens')}) AS cc_t,
            MAX(${usageSqlExpr('cacheReadInputTokens')})     AS cr_t,
            MIN(ts) AS min_ts
       FROM messages
      WHERE ts >= $1 AND ts ${opts.toInclusive ? '<=' : '<'} $2${ids}
        AND role IN ('assistant', 'tool_use')
        AND json_extract(raw_json, '${USAGE_PRESENCE_JSON_PATH}') IS NOT NULL
      GROUP BY session_id, seq / ${SEQ_STRIDE}, CAST(ts / ${HOUR_MS} AS INTEGER)`,
    params,
  );
  return rows.map((r) => ({
    key: `${r.session_id}\u0000${r.line}`,
    m: { inT: r.in_t ?? 0, outT: r.out_t ?? 0, ccT: r.cc_t ?? 0, crT: r.cr_t ?? 0, minTs: r.min_ts },
  }));
}

function hourOf(ts: number): number {
  return Math.floor(ts / HOUR_MS) * HOUR_MS;
}

async function cachedWindowUsage(startTs: number, endTs: number): Promise<WindowUsageTotals> {
  const st = usageHours;
  const db = await getDb();
  const top = await db.select<{ max_id: number | null }[]>(`SELECT MAX(id) AS max_id FROM messages`);
  const maxId = top[0]?.max_id ?? 0;

  // The closed hours wholly inside the window: [firstFull, open).
  const firstFull = Math.ceil(startTs / HOUR_MS) * HOUR_MS;
  const open = hourOf(endTs);

  // Rows added since the last read, into every hour already held. Rows in an
  // hour not held yet are read with it below; rows in the open hour are read
  // every time.
  if (st.lastId >= 0 && maxId > st.lastId && st.hours.size > 0) {
    const held = [...st.hours.keys()];
    const lo = Math.min(...held);
    const hi = Math.max(...held) + HOUR_MS;
    for (const { key, m } of await usageLines(lo, hi, { idAfter: st.lastId, idUpTo: maxId })) {
      const bucket = st.hours.get(hourOf(m.minTs));
      if (bucket) mergeLine(bucket, key, m);
    }
  }
  st.lastId = maxId;

  // The hours not held yet, in one read per run of them.
  let runFrom: number | null = null;
  const runs: Array<[number, number]> = [];
  for (let h = firstFull; h < open; h += HOUR_MS) {
    if (!st.hours.has(h)) runFrom ??= h;
    else if (runFrom !== null) {
      runs.push([runFrom, h]);
      runFrom = null;
    }
  }
  if (runFrom !== null) runs.push([runFrom, open]);
  for (const [from, to] of runs) {
    const fresh = new Map<number, Map<string, LineMax>>();
    for (let h = from; h < to; h += HOUR_MS) fresh.set(h, new Map());
    for (const { key, m } of await usageLines(from, to, { idUpTo: maxId })) {
      const bucket = fresh.get(hourOf(m.minTs));
      if (bucket) mergeLine(bucket, key, m);
    }
    for (const [h, bucket] of fresh) st.hours.set(h, bucket);
  }
  for (const h of [...st.hours.keys()]) if (h < endTs - CACHE_KEEP_MS) st.hours.delete(h);

  // Merge per group: the window's first, partial hour, the held hours, and
  // the open hour, each read as it is now.
  const lines = new Map<string, LineMax>();
  if (startTs < firstFull) {
    for (const { key, m } of await usageLines(startTs, Math.min(firstFull, endTs), { toInclusive: firstFull > endTs })) {
      mergeLine(lines, key, m);
    }
  }
  for (let h = firstFull; h < open; h += HOUR_MS) {
    for (const [key, m] of st.hours.get(h) ?? []) mergeLine(lines, key, m);
  }
  if (endTs >= Math.max(open, startTs)) {
    for (const { key, m } of await usageLines(Math.max(open, startTs), endTs, { toInclusive: true })) {
      mergeLine(lines, key, m);
    }
  }

  const out: WindowUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    lineCount: lines.size,
    oldestTs: null,
  };
  for (const m of lines.values()) {
    out.inputTokens += m.inT;
    out.outputTokens += m.outT;
    out.cacheCreationInputTokens += m.ccT;
    out.cacheReadInputTokens += m.crT;
    if (out.oldestTs === null || m.minTs < out.oldestTs) out.oldestTs = m.minTs;
  }
  return out;
}

/**
 * Token totals over `[startTs, endTs]`, across all sessions. The closed hours
 * of a long window come from a cache (#365); the answer is the one query's.
 */
export async function getWindowUsageTotals(startTs: number, endTs: number): Promise<WindowUsageTotals> {
  if (!usageCacheOn || !(endTs - startTs >= CACHE_MIN_SPAN_MS) || endTs - startTs > CACHE_KEEP_MS) {
    return getWindowUsageTotalsExact(startTs, endTs);
  }
  // One at a time: two windows read together share, and grow, one cache.
  const run = usageChain.then(() => cachedWindowUsage(startTs, endTs));
  usageChain = run.catch(() => {});
  return run;
}

/**
 * Total characters of stored `body` text for a session.
 *
 * Basis for the conversation-size ESTIMATE in contextBands(). Note `body` is a
 * projection truncated at BODY_MAX_CHARS per row, so for sessions with very
 * large tool results this undercounts -- which is one more reason the band is
 * labelled estimated.
 */
export async function getSessionBodyChars(sessionId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ chars: number | null }[]>(
    `SELECT COALESCE(SUM(LENGTH(body)), 0) AS chars
       FROM messages WHERE session_id = $1 AND body IS NOT NULL`,
    [sessionId],
  );
  return rows[0]?.chars ?? 0;
}

/**
 * Transcript files that have never been scanned for a title.
 *
 * NULL means "not scanned"; '' means "scanned, no title line in the file".
 * Without that distinction the one-time backfill would re-read every titleless
 * transcript on every launch -- 415 files and hundreds of megabytes here.
 */
export async function listTranscriptFilesNeedingTitle(): Promise<
  { path: string; sessionId: string }[]
> {
  const db = await getDb();
  return db.select<{ path: string; sessionId: string }[]>(
    `SELECT path, session_id AS sessionId FROM transcript_files
      WHERE title IS NULL ORDER BY COALESCE(mtime, 0) DESC`,
  );
}

/** Record a scanned title, or '' to mark the file as scanned and titleless. */
export async function setTranscriptTitle(path: string, title: string | null): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE transcript_files SET title = $1 WHERE path = $2`, [title ?? '', path]);
}
