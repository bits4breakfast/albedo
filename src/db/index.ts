/**
 * src/db/index.ts
 *
 * The SQLite access layer. Owns the snake_case <-> camelCase mapping in ONE
 * place, so a column rename is a single-file change.
 *
 * Public surface is frozen in docs/INTERFACES.md. The extra exports below it
 * (message insertion, transcript_files bookkeeping, task adoption) are
 * internal to the capture workstream, which owns this file.
 */

import Database from '@tauri-apps/plugin-sql';
import type { Message, MessageRole, NewTask, ParsedMessage, Task, TaskStatus } from '../types';
import {
  contextUsedSqlExpr,
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
}

// ---------------------------------------------------------------------------
// Task change notification (lead ruling #4)
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
  status: string;
  created_at: number;
  last_activity_at: number | null;
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
  status: 'status',
  createdAt: 'created_at',
  lastActivityAt: 'last_activity_at',
};

const TASK_SELECT =
  'id, title, project_id, repo_path, base_branch, branch, worktree_path, session_id, status, created_at, last_activity_at';
const MESSAGE_SELECT = 'id, task_id, session_id, seq, role, tool_name, target_path, body, raw_json, ts';

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
    status: (VALID_STATUSES.has(r.status) ? r.status : 'idle') as TaskStatus,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
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
    `INSERT INTO tasks (title, project_id, repo_path, base_branch, branch, worktree_path, session_id, status, created_at, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, 'idle', $7, NULL)`,
    [t.title, t.projectId, t.repoPath, t.baseBranch, t.branch, t.worktreePath, createdAt],
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
    status: 'idle',
    createdAt,
    lastActivityAt: null,
  };
}

export async function updateTask(id: number, patch: Partial<Task>): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const key of Object.keys(patch) as (keyof Task)[]) {
    if (key === 'id') continue; // never reassign the primary key
    const column = TASK_COLUMN[key];
    if (column === undefined) continue; // unknown field: ignore, do not inject
    binds.push(patch[key]);
    sets.push(`${column} = $${binds.length}`);
  }
  if (sets.length === 0) return;
  binds.push(id);
  const db = await getDb();
  await db.execute(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${binds.length}`, binds);
  emitTasksChanged();
}

export async function archiveTask(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE tasks SET status = 'archived' WHERE id = $1`, [id]);
  emitTasksChanged();
}

/** Capture-side: adopt a transcript whose cwd is a task's worktree. */
export async function findTaskByWorktreePath(worktreePath: string): Promise<Task | null> {
  const db = await getDb();
  const rows = await db.select<TaskRow[]>(
    `SELECT ${TASK_SELECT} FROM tasks WHERE worktree_path = $1 ORDER BY id DESC LIMIT 1`,
    [worktreePath],
  );
  const row = rows[0];
  return row ? toTask(row) : null;
}

/**
 * Record that a task's session produced activity. `last_activity_at` only ever
 * moves forward, so replaying an old file during backfill cannot rewrite a
 * live task's recency.
 */
export async function touchTaskActivity(
  taskId: number,
  sessionId: string,
  ts: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE tasks
        SET session_id = $1,
            last_activity_at = MAX(COALESCE(last_activity_at, 0), $2)
      WHERE id = $3`,
    [sessionId, ts, taskId],
  );
  emitTasksChanged();
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const DEFAULT_MESSAGE_LIMIT = 5000;

export interface GetMessagesOptions {
  taskId?: number;
  sessionId?: string;
  afterSeq?: number;
  limit?: number;
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
  const seqScoped = opts.taskId === undefined && opts.sessionId !== undefined;
  return seqScoped ? ['seq', 'ts', 'id'] : ['ts', 'seq', 'id'];
}

/** Which end of the result set `limit` truncates. */
export type PageDirection = 'head' | 'tail';

/**
 * `limit` semantics depend on which way the caller is paging:
 *
 *   afterSeq ABSENT  -> 'tail', keep the MOST RECENT rows. deriveStatus needs
 *                       this; fed the oldest 400 rows of a long session it
 *                       would report a stale status forever.
 *   afterSeq PRESENT -> 'head', keep the OLDEST rows after that seq. The
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
  return opts.afterSeq === undefined ? 'tail' : 'head';
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
  if (opts.afterSeq !== undefined) {
    // exclusive: pages forward from the last seq the caller already has
    binds.push(opts.afterSeq);
    where.push(`seq > $${binds.length}`);
  }
  binds.push(Math.max(1, opts.limit ?? DEFAULT_MESSAGE_LIMIT));

  const keys = messageOrderKeys(opts);
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
  await db.execute(`UPDATE messages SET task_id = $1 WHERE session_id = $2 AND task_id IS NULL`, [
    taskId,
    sessionId,
  ]);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchHit {
  message: Message;
  snippet: string;
  taskTitle: string | null;
}

interface SearchRow extends MessageRow {
  snippet: string | null;
  task_title: string | null;
}

const DEFAULT_SEARCH_LIMIT = 100;

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

export async function searchMessages(
  query: string,
  opts?: {
    taskId?: number;
    repoPath?: string;
    toolName?: string;
    since?: number;
    until?: number;
    limit?: number;
  },
): Promise<SearchHit[]> {
  const match = toFtsQuery(query);
  if (match === null) return [];

  const binds: unknown[] = [match];
  const where: string[] = ['messages_fts MATCH $1'];

  if (opts?.taskId !== undefined) {
    binds.push(opts.taskId);
    where.push(`m.task_id = $${binds.length}`);
  }
  if (opts?.repoPath !== undefined) {
    binds.push(opts.repoPath);
    where.push(`t.repo_path = $${binds.length}`);
  }
  if (opts?.toolName !== undefined) {
    binds.push(opts.toolName);
    where.push(`m.tool_name = $${binds.length}`);
  }
  if (opts?.since !== undefined) {
    binds.push(opts.since);
    where.push(`m.ts >= $${binds.length}`);
  }
  if (opts?.until !== undefined) {
    binds.push(opts.until);
    where.push(`m.ts <= $${binds.length}`);
  }
  binds.push(Math.max(1, opts?.limit ?? DEFAULT_SEARCH_LIMIT));

  const db = await getDb();
  const rows = await db.select<SearchRow[]>(
    `SELECT ${MESSAGE_SELECT.split(', ').map((c) => `m.${c}`).join(', ')},
            snippet(messages_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet,
            t.title AS task_title
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       LEFT JOIN tasks t ON t.id = m.task_id
      WHERE ${where.join(' AND ')}
      ORDER BY rank
      LIMIT $${binds.length}`,
    binds,
  );

  return rows.map((r) => ({
    message: toMessage(r),
    snippet: r.snippet ?? '',
    taskTitle: r.task_title,
  }));
}

// ---------------------------------------------------------------------------
// transcript_files — watcher bookkeeping
// ---------------------------------------------------------------------------

export interface TranscriptFileRecord {
  path: string;
  sessionId: string;
  projectDir: string;
  cwd: string | null;
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
  bytes_ingested: number;
  last_seq: number;
  mtime: number | null;
  updated_at: number;
}

const TRANSCRIPT_SELECT = 'path, session_id, project_dir, cwd, bytes_ingested, last_seq, mtime, updated_at';

function toTranscriptFile(r: TranscriptFileRow): TranscriptFileRecord {
  return {
    path: r.path,
    sessionId: r.session_id,
    projectDir: r.project_dir,
    cwd: r.cwd,
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
    `INSERT INTO transcript_files (path, session_id, project_dir, cwd, bytes_ingested, last_seq, mtime, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(path) DO UPDATE SET
       session_id     = excluded.session_id,
       project_dir    = excluded.project_dir,
       cwd            = COALESCE(excluded.cwd, transcript_files.cwd),
       bytes_ingested = excluded.bytes_ingested,
       last_seq       = excluded.last_seq,
       mtime          = excluded.mtime,
       updated_at     = excluded.updated_at`,
    [
      rec.path,
      rec.sessionId,
      rec.projectDir,
      rec.cwd,
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
 * Sessions per IN(...) clause. The ids are bound twice (peak subquery and
 * outer filter), so this stays well inside MAX_BIND_PARAMS.
 */
const CONTEXT_SESSION_CHUNK = 400;

export interface SessionContextRow {
  sessionId: string;
  /** Highest context occupancy seen anywhere in the session. */
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
 * Note the outer query has exactly one aggregate, MAX(m.seq); SQLite then
 * guarantees the bare `m.ts` / `m.raw_json` columns come from the row that
 * produced that maximum. That guarantee is why peak is computed in a
 * subquery instead of as a second aggregate alongside it.
 */
export async function getSessionContextRows(
  sessionIds: string[],
): Promise<SessionContextRow[]> {
  if (sessionIds.length === 0) return [];
  const db = await getDb();
  const usedExpr = contextUsedSqlExpr('raw_json');
  const out: SessionContextRow[] = [];

  for (let start = 0; start < sessionIds.length; start += CONTEXT_SESSION_CHUNK) {
    const chunk = sessionIds.slice(start, start + CONTEXT_SESSION_CHUNK);
    const inner = chunk.map((_, i) => `$${i + 1}`).join(', ');
    const outer = chunk.map((_, i) => `$${chunk.length + i + 1}`).join(', ');
    const rows = await db.select<
      {
        session_id: string;
        latest_ts: number | null;
        latest_raw: string | null;
        peak_used: number | null;
      }[]
    >(
      `SELECT m.session_id AS session_id,
              MAX(m.seq)   AS latest_seq,
              m.ts         AS latest_ts,
              m.raw_json   AS latest_raw,
              p.peak_used  AS peak_used
         FROM messages m
         JOIN (
            SELECT session_id, MAX(${usedExpr}) AS peak_used
              FROM messages
             WHERE session_id IN (${inner}) AND role IN ('assistant', 'tool_use')
             GROUP BY session_id
         ) p ON p.session_id = m.session_id
        WHERE m.session_id IN (${outer})
          AND m.role IN ('assistant', 'tool_use')
          AND json_extract(m.raw_json, '${USAGE_PRESENCE_JSON_PATH}') IS NOT NULL
        GROUP BY m.session_id`,
      [...chunk, ...chunk],
    );
    for (const r of rows) {
      out.push({
        sessionId: r.session_id,
        peakUsed: r.peak_used ?? 0,
        latestRawJson: r.latest_raw,
        latestTs: r.latest_ts,
      });
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
        WHERE session_id IN (${slots}) AND role IN ('assistant', 'tool_use')
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

export async function getWindowUsageTotals(
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
