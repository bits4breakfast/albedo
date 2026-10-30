/**
 * Reminders (migration 0010, issue #156): rows and their state changes.
 *
 * Plain storage. What a reminder captures when it is set, when it fires and
 * where its card goes live in src/reminders/; this file only reads and
 * writes. Every write tells `onRemindersChanged` listeners, whoever wrote it.
 *
 * Firing is a claim: `claimDue` moves one row from waiting to `fired` only if
 * it is still waiting and due, and says whether it did. Two checks racing
 * (a launch check and the first minute's) cannot both fire it.
 */

import type { Reminder, ReminderAuthor, ReminderState } from '../types';
import { getDb } from './index';

interface Row {
  id: number;
  task_id: number;
  project_id: number | null;
  text: string;
  due_at: number;
  created_at: number;
  updated_at: number;
  created_by: string;
  session_id: string | null;
  transcript_path: string | null;
  repo_path: string;
  worktree_path: string;
  branch: string | null;
  head_sha: string | null;
  brief: string | null;
  state: string;
  fired_at: number | null;
  card_task_id: number | null;
}

const STATES: ReadonlySet<string> = new Set<ReminderState>(['pending', 'snoozed', 'fired', 'sent', 'dismissed']);

function fromRow(r: Row): Reminder {
  return {
    id: r.id,
    taskId: r.task_id,
    projectId: r.project_id,
    text: r.text,
    dueAt: r.due_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by === 'session' ? 'session' : 'user',
    sessionId: r.session_id,
    transcriptPath: r.transcript_path,
    repoPath: r.repo_path,
    worktreePath: r.worktree_path,
    branch: r.branch,
    headSha: r.head_sha,
    brief: r.brief,
    // An unknown state reads as done, so it can never fire by accident.
    state: STATES.has(r.state) ? (r.state as ReminderState) : 'dismissed',
    firedAt: r.fired_at,
    cardTaskId: r.card_task_id,
  };
}

// ---------------------------------------------------------------------------
// Change events
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

/** Told whenever any reminder changed. */
export function onRemindersChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function changed(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      /* a broken subscriber is not the writer's problem */
    }
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Everything a new row records. The state is always `pending`. */
export interface ReminderRecord {
  taskId: number;
  projectId: number | null;
  text: string;
  dueAt: number;
  createdBy: ReminderAuthor;
  sessionId: string | null;
  transcriptPath: string | null;
  repoPath: string;
  worktreePath: string;
  branch: string | null;
  headSha: string | null;
  brief: string | null;
}

export async function insertReminder(r: ReminderRecord, now = Date.now()): Promise<Reminder> {
  const db = await getDb();
  const res = await db.execute(
    `INSERT INTO reminders (task_id, project_id, text, due_at, created_at, updated_at, created_by,
                            session_id, transcript_path, repo_path, worktree_path, branch, head_sha,
                            brief, state, fired_at, card_task_id)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', NULL, NULL)`,
    [
      r.taskId, r.projectId, r.text, r.dueAt, now, r.createdBy, r.sessionId, r.transcriptPath,
      r.repoPath, r.worktreePath, r.branch, r.headSha, r.brief,
    ],
  );
  const id = Number(res.lastInsertId ?? 0);
  changed();
  const row = await getReminder(id);
  if (!row) throw new Error(`reminder ${id} was not saved`);
  return row;
}

/**
 * New text and time for a reminder that is still waiting. A fired one is
 * rescheduled with {@link snoozeReminder}. False when it is no longer waiting.
 */
export async function editReminder(id: number, patch: { text: string; dueAt: number }, now = Date.now()): Promise<boolean> {
  const db = await getDb();
  const res = await db.execute(
    `UPDATE reminders SET text = $2, due_at = $3, updated_at = $4
      WHERE id = $1 AND state IN ('pending', 'snoozed')`,
    [id, patch.text, patch.dueAt, now],
  );
  changed();
  return res.rowsAffected > 0;
}

/**
 * Back later: waiting again until `dueAt`. Its card goes; the task it showed
 * on is kept, so it comes back there rather than opening another task.
 */
export async function snoozeReminder(id: number, dueAt: number, now = Date.now()): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE reminders SET state = 'snoozed', due_at = $2, updated_at = $3 WHERE id = $1`,
    [id, dueAt, now],
  );
  changed();
}

/**
 * Fire it: waiting and due becomes `fired`. True only for the call that moved
 * it, so a reminder fires once however many checks race.
 */
export async function claimDue(id: number, now = Date.now()): Promise<boolean> {
  const db = await getDb();
  const res = await db.execute(
    `UPDATE reminders SET state = 'fired', fired_at = $2, updated_at = $2
      WHERE id = $1 AND state IN ('pending', 'snoozed') AND due_at <= $2`,
    [id, now],
  );
  const moved = res.rowsAffected > 0;
  if (moved) changed();
  return moved;
}

/** Where its card shows. */
export async function setCardTask(id: number, taskId: number): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE reminders SET card_task_id = $2 WHERE id = $1`, [id, taskId]);
  changed();
}

/** Done: sent to Claude, or dismissed. */
export async function closeReminder(id: number, state: 'sent' | 'dismissed', now = Date.now()): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE reminders SET state = $2, updated_at = $3 WHERE id = $1`, [id, state, now]);
  changed();
}

export async function deleteReminder(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM reminders WHERE id = $1`, [id]);
  changed();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getReminder(id: number): Promise<Reminder | null> {
  const db = await getDb();
  const rows = await db.select<Row[]>(`SELECT * FROM reminders WHERE id = $1`, [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** A task's reminders still to come (pending or snoozed), soonest first. */
export async function listWaiting(taskId: number): Promise<Reminder[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    `SELECT * FROM reminders
      WHERE state IN ('pending', 'snoozed') AND (task_id = $1 OR card_task_id = $1)
      ORDER BY due_at, id`,
    [taskId],
  );
  return rows.map(fromRow);
}

/** The cards a task shows: fired and delivered to it, oldest first. */
export async function listCards(taskId: number): Promise<Reminder[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    `SELECT * FROM reminders WHERE state = 'fired' AND card_task_id = $1 ORDER BY due_at, id`,
    [taskId],
  );
  return rows.map(fromRow);
}

/** Every task showing a card, for the task row's "Reminder" mark. */
export async function cardTaskIds(): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(
    `SELECT DISTINCT card_task_id AS id FROM reminders WHERE state = 'fired' AND card_task_id IS NOT NULL`,
  );
  return rows.map((r) => r.id);
}

/** Waiting and due by `now`, oldest first. */
export async function listDue(now: number): Promise<Reminder[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    `SELECT * FROM reminders WHERE state IN ('pending', 'snoozed') AND due_at <= $1 ORDER BY due_at, id`,
    [now],
  );
  return rows.map(fromRow);
}

/** Fired, but no task took the card (delivery failed): tried again. */
export async function listUndelivered(): Promise<Reminder[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    `SELECT * FROM reminders WHERE state = 'fired' AND card_task_id IS NULL ORDER BY due_at, id`,
  );
  return rows.map(fromRow);
}

/** The newest main transcript file Albedo holds for a session, or null. */
export async function transcriptPathFor(sessionId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ path: string }[]>(
    `SELECT path FROM transcript_files
      WHERE session_id = $1 AND path NOT LIKE '%/subagents/%'
      ORDER BY updated_at DESC LIMIT 1`,
    [sessionId],
  );
  return rows[0]?.path ?? null;
}
