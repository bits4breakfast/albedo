/**
 * Review comments: notes left on a task's files, then sent to Claude Code.
 *
 * Stored in SQLite (migration 0007), so nothing is lost to a crash or a
 * restart. A row goes away only when the person deletes it or the task goes
 * away (purgeTaskHistory, on archive and delete). Resolving keeps the row.
 *
 * Comments are anchored by TEXT, not by line number: each keeps the lines it
 * was written on, and `relocate` finds them again in the file as it is now.
 * See src/lib/anchor.ts for why exact text and not a fuzzy match.
 */

import { anchorBlock, fileLines } from '../lib/anchor';
import { getDb } from './index';

export interface ReviewComment {
  id: number;
  taskId: number;
  /** Worktree-relative. */
  path: string;
  /** 1-based, inclusive: where the comment was last found. */
  lineStart: number;
  lineEnd: number;
  /** The commented lines as they were, joined with \n. */
  anchorText: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  resolvedAt: number | null;
}

interface Row {
  id: number;
  task_id: number;
  path: string;
  line_start: number;
  line_end: number;
  anchor_text: string;
  body: string;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  resolved_at: number | null;
}

function fromRow(r: Row): ReviewComment {
  return {
    id: r.id,
    taskId: r.task_id,
    path: r.path,
    lineStart: r.line_start,
    lineEnd: r.line_end,
    anchorText: r.anchor_text,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sentAt: r.sent_at,
    resolvedAt: r.resolved_at,
  };
}

// ---------------------------------------------------------------------------
// Change events
// ---------------------------------------------------------------------------

const listeners = new Set<(taskId: number) => void>();

/** Told the task whose comments changed, whoever changed them. */
export function onCommentsChanged(cb: (taskId: number) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function changed(taskId: number): void {
  for (const cb of [...listeners]) {
    try {
      cb(taskId);
    } catch {
      /* a broken subscriber is not the writer's problem */
    }
  }
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------

/** A task's comments, by file then line. Resolved ones only when asked. */
export async function listComments(taskId: number, opts: { includeResolved?: boolean } = {}): Promise<ReviewComment[]> {
  const db = await getDb();
  const open = opts.includeResolved ? '' : ' AND resolved_at IS NULL';
  const rows = await db.select<Row[]>(
    `SELECT * FROM comments WHERE task_id = $1${open} ORDER BY path, line_start, id`,
    [taskId],
  );
  return rows.map(fromRow);
}

export async function addComment(c: {
  taskId: number;
  path: string;
  lineStart: number;
  lineEnd: number;
  anchorText: string;
  body: string;
}): Promise<number> {
  const db = await getDb();
  const now = Date.now();
  const res = await db.execute(
    `INSERT INTO comments (task_id, path, line_start, line_end, anchor_text, body, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [c.taskId, c.path, c.lineStart, c.lineEnd, c.anchorText, c.body, now],
  );
  changed(c.taskId);
  return Number(res.lastInsertId ?? 0);
}

/** New text. An edited comment counts as unsent again: Claude Code has not seen this version. */
export async function editComment(taskId: number, id: number, body: string): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE comments SET body = $2, updated_at = $3, sent_at = NULL WHERE id = $1`, [id, body, Date.now()]);
  changed(taskId);
}

/** Where the comment's lines are now (they moved; their text did not). */
export async function moveComment(taskId: number, id: number, lineStart: number, lineEnd: number): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE comments SET line_start = $2, line_end = $3 WHERE id = $1`, [id, lineStart, lineEnd]);
  changed(taskId);
}

export async function markCommentsSent(taskId: number, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const now = Date.now();
  for (const id of ids) await db.execute(`UPDATE comments SET sent_at = $2 WHERE id = $1`, [id, now]);
  changed(taskId);
}

export async function resolveComment(taskId: number, id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE comments SET resolved_at = $2 WHERE id = $1`, [id, Date.now()]);
  changed(taskId);
}

export async function deleteComment(taskId: number, id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM comments WHERE id = $1`, [id]);
  changed(taskId);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type Placement =
  /** Found: these are its lines in the text given. */
  | { state: 'current'; lineStart: number; lineEnd: number }
  /** Its lines are no longer in the file (or are there more than once with no way to tell). */
  | { state: 'outdated' };

/** Where a comment's lines are in `text`, preferring the copy nearest its last place. */
export function relocate(comment: Pick<ReviewComment, 'anchorText' | 'lineStart'>, text: string): Placement {
  const block = comment.anchorText.split('\n');
  const found = anchorBlock(fileLines(text), block, comment.lineStart);
  if (!found.ok) return { state: 'outdated' };
  return { state: 'current', lineStart: found.offset + 1, lineEnd: found.offset + block.length };
}

/** `path:12` or `path:12-14`: how a comment names its place, in the message and in lists. */
export function commentLocation(c: Pick<ReviewComment, 'path' | 'lineStart' | 'lineEnd'>): string {
  return c.lineStart === c.lineEnd ? `${c.path}:${c.lineStart}` : `${c.path}:${c.lineStart}-${c.lineEnd}`;
}

/** The opening line of the message, until the person writes their own. */
export const DEFAULT_COMMENTS_INTRO = 'I left some review comments on your changes. Please address each one:';

/**
 * The message for Claude Code: the intro, then one numbered item per comment
 * with its place, the code as it was commented on, and the comment. Fenced
 * with enough backticks that code containing ``` cannot close it.
 */
export function formatForClaude(comments: readonly ReviewComment[], intro: string = DEFAULT_COMMENTS_INTRO): string {
  const items = comments.map((c, i) => {
    const longest = Math.max(2, ...(c.anchorText.match(/`+/g) ?? []).map((m) => m.length));
    const fence = '`'.repeat(longest + 1);
    return `${i + 1}. ${commentLocation(c)}\n${fence}\n${c.anchorText}\n${fence}\n${c.body.trim()}`;
  });
  const head = intro.trim();
  return `${head === '' ? '' : `${head}\n\n`}${items.join('\n\n')}`;
}
