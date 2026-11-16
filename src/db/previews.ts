/**
 * Previews (migration 0018, issue #348): the frozen versions of HTML mockups
 * sessions showed for approval.
 *
 * Plain storage. Where a version comes from and how it is answered is
 * src/capture/previewGate.ts; this file only reads and writes. Every write
 * tells `onPreviewsChanged` listeners, whoever wrote it.
 *
 * The version number is given here, at insert: one more than the task's
 * highest for the same title. The insert and the count are one statement, so
 * two versions arriving together cannot share a number.
 *
 * An outcome changes once: only a `pending` row is ever settled, so a late
 * answer, a cancel after an answer, or a second click cannot overwrite what
 * happened first.
 */

import type { Preview, PreviewOutcome } from '../types';
import { getDb } from './index';

interface Row {
  id: number;
  task_id: number;
  request_id: string;
  tool_use_id: string | null;
  title: string;
  version: number;
  html: string;
  question: string | null;
  note: string | null;
  created_at: number;
  outcome: string;
  answer: string | null;
  answered_at: number | null;
}

const OUTCOMES: ReadonlySet<string> = new Set<PreviewOutcome>(['pending', 'approved', 'changes', 'cancelled']);

function fromRow(r: Row): Preview {
  return {
    id: r.id,
    taskId: r.task_id,
    requestId: r.request_id,
    toolUseId: r.tool_use_id,
    title: r.title,
    version: r.version,
    html: r.html,
    question: r.question,
    note: r.note,
    createdAt: r.created_at,
    // An unknown outcome reads as over: nothing can answer it by accident.
    outcome: OUTCOMES.has(r.outcome) ? (r.outcome as PreviewOutcome) : 'cancelled',
    answer: r.answer,
    answeredAt: r.answered_at,
  };
}

const listeners = new Set<() => void>();

/** Told whenever any preview row changed. */
export function onPreviewsChanged(cb: () => void): () => void {
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

export interface PreviewRecord {
  taskId: number;
  requestId: string;
  toolUseId: string | null;
  title: string;
  html: string;
  question: string | null;
  note: string | null;
  createdAt: number;
  /** `pending` for a call that waits; `cancelled` for one already over. */
  outcome: 'pending' | 'cancelled';
}

/**
 * Keep one version. Numbered after the task's other versions of the same
 * title. A request already stored (the inbox read twice) is returned as it is.
 */
export async function insertPreview(r: PreviewRecord): Promise<Preview> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO previews (task_id, request_id, tool_use_id, title, version, html, question, note,
                           created_at, outcome, answer, answered_at)
     SELECT $1, $2, $3, $4,
            COALESCE((SELECT MAX(version) FROM previews WHERE task_id = $1 AND title = $4), 0) + 1,
            $5, $6, $7, $8, $9, NULL, NULL
      WHERE NOT EXISTS (SELECT 1 FROM previews WHERE request_id = $2)`,
    [r.taskId, r.requestId, r.toolUseId, r.title, r.html, r.question, r.note, r.createdAt, r.outcome],
  );
  changed();
  const row = await previewByRequest(r.requestId);
  if (!row) throw new Error(`preview ${r.requestId} was not saved`);
  return row;
}

/**
 * Settle a waiting version. True only for the call that moved it from
 * `pending`: a second settle (a cancel arriving after the answer was taken)
 * changes nothing.
 */
export async function settlePreview(
  requestId: string,
  outcome: Exclude<PreviewOutcome, 'pending'>,
  answer: string | null,
  now = Date.now(),
): Promise<boolean> {
  const db = await getDb();
  const res = await db.execute(
    `UPDATE previews SET outcome = $2, answer = $3, answered_at = $4
      WHERE request_id = $1 AND outcome = 'pending'`,
    [requestId, outcome, answer, now],
  );
  const moved = res.rowsAffected > 0;
  if (moved) changed();
  return moved;
}

/**
 * Every version still waiting, of any task: at launch, none of them can be
 * (the sessions they waited in ended with the app).
 */
export async function pendingPreviews(): Promise<Preview[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(`SELECT * FROM previews WHERE outcome = 'pending' ORDER BY id`);
  return rows.map(fromRow);
}

export async function previewByRequest(requestId: string): Promise<Preview | null> {
  const db = await getDb();
  const rows = await db.select<Row[]>(`SELECT * FROM previews WHERE request_id = $1`, [requestId]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** The version a transcript's tool call made, by Claude Code's id for it. */
export async function previewByToolUse(toolUseId: string): Promise<Preview | null> {
  const db = await getDb();
  const rows = await db.select<Row[]>(`SELECT * FROM previews WHERE tool_use_id = $1 ORDER BY id DESC LIMIT 1`, [
    toolUseId,
  ]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Every version of one title on a task, v1 first. */
export async function previewVersions(taskId: number, title: string): Promise<Preview[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    `SELECT * FROM previews WHERE task_id = $1 AND title = $2 ORDER BY version`,
    [taskId, title],
  );
  return rows.map(fromRow);
}
