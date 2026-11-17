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
import { diffSequences } from '../lib/diff';
import { fenceFor, splitSuggestion } from '../lib/suggestion';
import { getDb } from './index';

type SeqOp = ReturnType<typeof diffSequences>[number];

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
  /**
   * Where it goes (#287, migration v15): null for Claude, as on every task;
   * 'draft' for GitHub, sent with Submit Review on a review task.
   */
  github: 'draft' | null;
  /** A reply to another reviewer's thread: the REST id of its first comment. Null otherwise. */
  replyTo: number | null;
  /**
   * Which side of a diff its lines are on (#402, migration v20). 'new': the
   * file as it is now, as every comment before v20. 'old': lines the change
   * removed, numbered and quoted from the diff's base. Every row read has
   * it; absent (a comment built elsewhere) means 'new' -- read it through
   * {@link sideOf}.
   */
  side?: CommentSide;
}

export type CommentSide = 'new' | 'old';

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
  github?: string | null;
  reply_to?: number | null;
  side?: string | null;
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
    github: r.github === 'draft' ? 'draft' : null,
    replyTo: typeof r.reply_to === 'number' ? r.reply_to : null,
    side: r.side === 'old' ? 'old' : 'new',
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

/**
 * A task's comments on its code, by file then line. Resolved ones only when
 * asked. Replies to GitHub threads (#287) are not on the code and are never
 * here: they hang on their thread ({@link listGithubDrafts}).
 */
export async function listComments(taskId: number, opts: { includeResolved?: boolean } = {}): Promise<ReviewComment[]> {
  const db = await getDb();
  const open = opts.includeResolved ? '' : ' AND resolved_at IS NULL';
  const rows = await db.select<Row[]>(
    `SELECT * FROM comments WHERE task_id = $1 AND reply_to IS NULL${open} ORDER BY path, line_start, id`,
    [taskId],
  );
  return rows.map(fromRow);
}

/**
 * A review task's drafts for GitHub not yet sent (#287): line comments and
 * replies, by file then line. What Submit Review sends, and its count.
 */
export async function listGithubDrafts(taskId: number): Promise<ReviewComment[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    `SELECT * FROM comments WHERE task_id = $1 AND github = 'draft' AND sent_at IS NULL AND resolved_at IS NULL
     ORDER BY path, line_start, id`,
    [taskId],
  );
  return rows.map(fromRow);
}

/** What a review task's comments say about its review (#315): how many, of which kind, and the latest change. */
export interface CommentFacts {
  /** Drafts for GitHub not yet submitted (line comments and replies). */
  drafts: number;
  /** Every comment, of either kind, sent or not, resolved or not. */
  total: number;
  /** The latest a comment was written or edited. */
  latestAt: number;
}

/**
 * {@link CommentFacts} for each of `taskIds` that has a comment, in one
 * query. Read again when {@link onCommentsChanged} names one of them, never
 * on a timer.
 */
export async function commentFacts(taskIds: readonly number[]): Promise<Map<number, CommentFacts>> {
  const out = new Map<number, CommentFacts>();
  if (taskIds.length === 0) return out;
  const db = await getDb();
  const params = taskIds.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await db.select<Array<{ task_id: number; total: number; drafts: number | null; latest: number | null }>>(
    `SELECT task_id, COUNT(*) AS total,
            SUM(CASE WHEN github = 'draft' AND sent_at IS NULL AND resolved_at IS NULL THEN 1 ELSE 0 END) AS drafts,
            MAX(updated_at) AS latest
     FROM comments WHERE task_id IN (${params}) GROUP BY task_id`,
    [...taskIds],
  );
  for (const r of rows) {
    out.set(Number(r.task_id), { total: Number(r.total), drafts: Number(r.drafts ?? 0), latestAt: Number(r.latest ?? 0) });
  }
  return out;
}

/**
 * GitHub accepted these drafts (#287): sent, and resolved at once -- the
 * thread GitHub now has for each takes its place on the code.
 */
export async function markDraftsPosted(taskId: number, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const now = Date.now();
  for (const id of ids) await db.execute(`UPDATE comments SET sent_at = $2, resolved_at = $2 WHERE id = $1`, [id, now]);
  changed(taskId);
}

/** Ask Claude or Draft for GitHub, changed on an existing comment (#287). */
export async function setCommentGithub(taskId: number, id: number, github: 'draft' | null): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE comments SET github = $2, sent_at = NULL, updated_at = $3 WHERE id = $1`, [id, github, Date.now()]);
  changed(taskId);
}

export type NewComment = Parameters<typeof addComment>[0];

/**
 * One comment on both sides of a diff (#402: a selection over deleted and
 * added lines), written in ONE statement: either both rows are stored or
 * neither is, so a failed save leaves nothing behind to be duplicated by the
 * next. Both get the same created_at, which is how {@link formatForClaude}
 * knows them for one comment.
 */
export async function addCommentsTogether(rows: readonly NewComment[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  const now = Date.now();
  const values: string[] = [];
  const binds: unknown[] = [];
  for (const c of rows) {
    const github = c.replyTo != null ? 'draft' : (c.github ?? null);
    const n = binds.length;
    const at = (k: number) => `$${n + k}`;
    values.push(`(${[1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 10].map(at).join(', ')})`);
    binds.push(c.taskId, c.path, c.lineStart, c.lineEnd, c.anchorText, c.body, now, github, c.replyTo ?? null, c.side === 'old' ? 'old' : 'new');
  }
  await db.execute(
    `INSERT INTO comments (task_id, path, line_start, line_end, anchor_text, body, created_at, updated_at, github, reply_to, side)
     VALUES ${values.join(', ')}`,
    binds,
  );
  for (const id of new Set(rows.map((c) => c.taskId))) changed(id);
}

export async function addComment(c: {
  taskId: number;
  path: string;
  lineStart: number;
  lineEnd: number;
  anchorText: string;
  body: string;
  /** #287: a draft for GitHub. Absent: for Claude. */
  github?: 'draft' | null;
  /** #287: a reply to the GitHub thread whose first comment has this id. */
  replyTo?: number | null;
  /** #402: 'old' for removed lines, by the base's lines and text. Absent: the file as it is now. */
  side?: CommentSide;
}): Promise<number> {
  const db = await getDb();
  const now = Date.now();
  // A reply always goes to GitHub: it answers someone there.
  const github = c.replyTo != null ? 'draft' : (c.github ?? null);
  const res = await db.execute(
    `INSERT INTO comments (task_id, path, line_start, line_end, anchor_text, body, created_at, updated_at, github, reply_to, side)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10)`,
    [c.taskId, c.path, c.lineStart, c.lineEnd, c.anchorText, c.body, now, github, c.replyTo ?? null, c.side === 'old' ? 'old' : 'new'],
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

/**
 * A message to Claude carrying these was delivered. Only comments for Claude:
 * one switched to Draft for GitHub (#287) while a held message carried it was
 * not sent anywhere, and stays a draft.
 */
export async function markCommentsSent(taskId: number, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const now = Date.now();
  for (const id of ids) await db.execute(`UPDATE comments SET sent_at = $2 WHERE id = $1 AND github IS NULL`, [id, now]);
  changed(taskId);
}

export async function resolveComment(taskId: number, id: number): Promise<void> {
  await resolveComments(taskId, [id]);
}

/** Several at once, one change event: what auto-resolve writes (#222). */
export async function resolveComments(taskId: number, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const now = Date.now();
  for (const id of ids) await db.execute(`UPDATE comments SET resolved_at = $2 WHERE id = $1`, [id, now]);
  changed(taskId);
}

/**
 * Back to open (#222), and unsent: reopening asks for it to be dealt with
 * again, so it waits for your next message. Left marked sent, a comment
 * whose lines are gone would be resolved again at the next look.
 */
export async function reopenComment(taskId: number, id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE comments SET resolved_at = NULL, sent_at = NULL WHERE id = $1`, [id]);
  changed(taskId);
}

/**
 * A removed row back exactly as it was (#427: Undo for a GitHub Draft the
 * session removed): the same id, lines, code, text, side, thread, times and
 * destination, so it is the same draft again, not a copy. The id is free:
 * `comments.id` is AUTOINCREMENT, which never hands a deleted id out again.
 */
export async function restoreComment(c: ReviewComment): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO comments (id, task_id, path, line_start, line_end, anchor_text, body, created_at, updated_at, sent_at, resolved_at, github, reply_to, side)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      c.id,
      c.taskId,
      c.path,
      c.lineStart,
      c.lineEnd,
      c.anchorText,
      c.body,
      c.createdAt,
      c.updatedAt,
      c.sentAt,
      c.resolvedAt,
      c.github,
      c.replyTo,
      sideOf(c),
    ],
  );
  changed(c.taskId);
}

/**
 * Remove one GitHub Draft the session asked to remove (#427): only while it
 * is still a draft of this task waiting for Submit Review, checked in the
 * same statement. True when it was removed. Not `deleteComment`, which
 * removes whatever the person points at, and stays that way.
 */
export async function deleteUnsentDraft(taskId: number, id: number): Promise<boolean> {
  const db = await getDb();
  const res = await db.execute(
    `DELETE FROM comments WHERE id = $1 AND task_id = $2 AND github = 'draft' AND sent_at IS NULL AND resolved_at IS NULL`,
    [id, taskId],
  );
  const removed = Number(res.rowsAffected ?? 0) > 0;
  if (removed) changed(taskId);
  return removed;
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

/** A comment's side; a row read before v20, or built without one, is on the file as it is now. */
export function sideOf(c: Partial<Pick<ReviewComment, 'side'>>): CommentSide {
  return c.side === 'old' ? 'old' : 'new';
}

export type RemovedPlacement =
  /**
   * Still removed: its lines are at lineStart..lineEnd of the base. `row` is
   * the last of them the change removes, the diff row its card goes under.
   * `before` is the line of the file now that took the removal's place (the
   * card "was above this line"); null when the removal was at the end of the
   * file, after `last`, the file's last line (0 when it is empty).
   */
  | { state: 'removed'; lineStart: number; lineEnd: number; row: number; before: number | null; last: number }
  /** Every one of its lines is in the file again, unchanged: what it asked about was undone. */
  | { state: 'back' }
  /** Its text is not in the base (the diff's base moved on): it cannot be placed. */
  | { state: 'outdated' };

/** Lines as the diff compares them: a CRLF file's `\r` is not part of a line (CodeMirror drops it too). */
function plainLines(text: string): string[] {
  return text === '' ? [] : fileLines(text).map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** The last line diff asked for: every comment on a file asks with the same two texts. */
let lastOps: { base: string; now: string; ops: SeqOp[] } | null = null;

function opsFor(base: string, now: string, old: readonly string[], cur: readonly string[]): SeqOp[] {
  if (lastOps && lastOps.base === base && lastOps.now === now) return lastOps.ops;
  const ops = diffSequences(old, cur);
  lastOps = { base, now, ops };
  return ops;
}

/**
 * Where a comment on removed lines (#402) stands: found again by its text in
 * `base`, the diff's old side, among the copies the change REMOVES -- the
 * nearest to its last place with at least one deleted line -- then followed
 * through the change to `now`, the file as it is. The same line diff the diff
 * view draws (`diffSequences`), so "back" means no copy of its text is
 * removed any more: never merely that the text occurs somewhere, nor that the
 * copy nearest its old line number is unchanged (a `}` always is, once the
 * base moves).
 */
export function placeRemoved(comment: Pick<ReviewComment, 'anchorText' | 'lineStart'>, base: string, now: string): RemovedPlacement {
  const block = comment.anchorText.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const old = plainLines(base);
  const cur = plainLines(now);
  // Every exact copy of its text in the base.
  const copies: number[] = [];
  for (let i = 0; i + block.length <= old.length; i++) {
    let hit = true;
    for (let j = 0; j < block.length && hit; j++) hit = old[i + j] === block[j];
    if (hit) copies.push(i);
  }
  if (block.length === 0 || copies.length === 0) return { state: 'outdated' };
  const ops = opsFor(base, now, old, cur);
  const deleted = new Set<number>();
  for (const op of ops) if (op.kind === 'del') deleted.add(op.oldIndex);
  // Of the copies the change removes (a line of it or more), the nearest.
  const want = comment.lineStart - 1;
  let first = -1;
  for (const at of copies) {
    let removes = false;
    for (let j = 0; j < block.length && !removes; j++) removes = deleted.has(at + j);
    if (removes && (first < 0 || Math.abs(at - want) < Math.abs(first - want))) first = at;
  }
  if (first < 0) return { state: 'back' };
  const last = first + block.length - 1;
  let row = first;
  for (let i = first; i <= last; i++) if (deleted.has(i)) row = i;
  // The line of the file that took the removal's place: the first after its
  // last removed line (or an added line in its stead).
  let before: number | null = null;
  let past = false;
  for (const op of ops) {
    if (op.kind === 'del' && op.oldIndex === row) past = true;
    else if (past && op.newIndex >= 0) {
      before = op.newIndex + 1;
      break;
    }
  }
  return { state: 'removed', lineStart: first + 1, lineEnd: last + 1, row: row + 1, before, last: cur.length };
}

// ---------------------------------------------------------------------------
// The life of a comment (#222)
// ---------------------------------------------------------------------------

export type CommentState = 'waiting' | 'sent' | 'resolved';

export function commentState(c: Pick<ReviewComment, 'sentAt' | 'resolvedAt'>): CommentState {
  if (c.resolvedAt !== null) return 'resolved';
  return c.sentAt !== null ? 'sent' : 'waiting';
}

type Anchored = Pick<ReviewComment, 'sentAt' | 'resolvedAt' | 'anchorText' | 'lineStart'> & Partial<Pick<ReviewComment, 'side'>>;

/**
 * The owner's rule: a comment that went to Claude and whose lines are no
 * longer in the file has been acted on, so it resolves itself. `text` is the
 * file as it is on disk; null means it could not be read, which decides
 * nothing. An unsent comment never resolves on its own: its lines changing
 * means the file moved under your note, not that it was answered.
 *
 * A comment on removed lines (#402) is the other way round: its lines being
 * missing is what it is about, so that never resolves it. Once sent, it
 * resolves when they are back in the file ({@link placeRemoved}), which needs
 * `base`, the diff's old side; without it nothing is decided.
 */
export function shouldAutoResolve(c: Anchored, text: string | null, base: string | null = null): boolean {
  if (c.sentAt === null || c.resolvedAt !== null || text === null) return false;
  if (sideOf(c) === 'old') return base !== null && placeRemoved(c, base, text).state === 'back';
  return relocate(c, text).state === 'outdated';
}

/**
 * Why a resolved comment is resolved, for the list. Not stored (no schema
 * change): derived from what auto-resolve acts on -- it was sent and its
 * lines are gone ('changed'), or for removed lines (#402), they are back
 * ('back', which needs `base`). A sent comment resolved by hand before its
 * lines changed reads "resolved by you" until they do.
 */
export function resolvedReason(c: Anchored, text: string | null, base: string | null = null): 'changed' | 'back' | 'you' | null {
  if (c.resolvedAt === null) return null;
  if (c.sentAt === null || text === null) return 'you';
  if (sideOf(c) === 'old') return base !== null && placeRemoved(c, base, text).state === 'back' ? 'back' : 'you';
  return relocate(c, text).state === 'outdated' ? 'changed' : 'you';
}

/** "removed line 12", "removed lines 12–14": a comment on removed lines (#402), by the base's numbers. */
export function removedLines(c: Pick<ReviewComment, 'lineStart' | 'lineEnd'>): string {
  return c.lineStart === c.lineEnd ? `removed line ${c.lineStart}` : `removed lines ${c.lineStart}–${c.lineEnd}`;
}

/**
 * `path:12` or `path:12-14`: how a comment names its place, in the message
 * and in lists. On removed lines (#402): `path: removed lines 12–14`.
 */
export function commentLocation(c: Pick<ReviewComment, 'path' | 'lineStart' | 'lineEnd'> & Partial<Pick<ReviewComment, 'side'>>): string {
  if (sideOf(c) === 'old') return `${c.path}: ${removedLines(c)}`;
  return c.lineStart === c.lineEnd ? `${c.path}:${c.lineStart}` : `${c.path}:${c.lineStart}-${c.lineEnd}`;
}

/** The opening line of the message, until the person writes their own. */
export const DEFAULT_COMMENTS_INTRO = 'I left some review comments on your changes. Please address each one:';

/**
 * The message for Claude Code: the intro, then one numbered item per comment
 * with its place, the code as it was commented on, and the comment. Fenced
 * with enough backticks that code containing ``` cannot close it.
 *
 * A comment carrying a suggested edit (#411) says so before its code, and
 * gives the replacement after it. The code quoted is always the lines as
 * they were commented on, which is what the suggestion replaces, even when
 * the file has moved on since.
 */
export function formatForClaude(comments: readonly ReviewComment[], intro: string = DEFAULT_COMMENTS_INTRO): string {
  // One comment written on both sides of a diff (#402) is two rows with the
  // same file, text and moment, one per side: one item, both places and both
  // quotes, its text once.
  const groups: ReviewComment[][] = [];
  for (const c of comments) {
    const twin = groups.find(
      (g) =>
        g.length === 1 &&
        g[0]!.path === c.path &&
        g[0]!.body === c.body &&
        g[0]!.createdAt === c.createdAt &&
        sideOf(g[0]!) !== sideOf(c),
    );
    if (twin) twin.push(c);
    else groups.push([c]);
  }
  // Where it is: on removed lines (#402) the code quoted is what was taken
  // out, and Claude is told so -- those lines are not in the file to look for.
  const where = (c: ReviewComment) =>
    sideOf(c) === 'old' ? `${commentLocation(c)} (in the base, not in the file now)` : commentLocation(c);
  const items = groups.map((g, i) => {
    // The removed lines first, as the diff shows them.
    const [c, other] = g.length === 2 && sideOf(g[1]!) === 'old' ? [g[1]!, g[0]!] : [g[0]!, g[1]];
    // A suggestion (#411) is only ever on the file now: a removed comment never carries one.
    const { suggestion, text } = sideOf(c) === 'old' ? { suggestion: null, text: c.body.trim() } : splitSuggestion(c.body);
    const fence = fenceFor([...c.anchorText.split('\n'), ...(suggestion ?? [])]);
    const quoted = `${fence}\n${c.anchorText}\n${fence}`;
    const tail = text === '' ? '' : `\n${text}`;
    if (other) {
      const f2 = fenceFor(other.anchorText.split('\n'));
      return `${i + 1}. ${where(c)}\n${quoted}\nand ${where(other)}\n${f2}\n${other.anchorText}\n${f2}${tail}`;
    }
    if (suggestion === null) return `${i + 1}. ${where(c)}\n${quoted}${tail}`;
    const these = c.lineStart === c.lineEnd ? 'this line' : 'these lines';
    const change =
      suggestion.length === 0
        ? `Suggested change: delete ${these}\n${quoted}`
        : `Suggested change: replace ${these}\n${quoted}\nwith\n${fence}\n${suggestion.join('\n')}\n${fence}`;
    return `${i + 1}. ${where(c)}\n${change}${tail}`;
  });
  const head = intro.trim();
  return `${head === '' ? '' : `${head}\n\n`}${items.join('\n\n')}`;
}
