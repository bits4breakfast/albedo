/**
 * GitHub Drafts the session removed (#427), kept so the user sees each
 * removal where the draft was -- Files ▸ Comments and its card in the diff --
 * with what was removed, the session's reason, and Undo.
 *
 * In memory, by task. The row removed is kept whole, so Undo puts back the
 * same draft (`restoreComment`: same id, lines, code, text, side and thread),
 * never a copy. A removal is shown until the user leaves the task -- having
 * had it open; one made while they were elsewhere waits for them -- or
 * submits its review. Nothing here is written to disk: a restart forgets the
 * lines, and the drafts stay removed, as a removal by hand does.
 */

import { restoreComment, type ReviewComment } from '../db/comments';

export interface DraftRemoval {
  /** The draft as it was when it was removed. */
  row: ReviewComment;
  /** The session's one line on why, or null. */
  reason: string | null;
  at: number;
}

const byTask = new Map<number, DraftRemoval[]>();
const listeners = new Set<(taskId: number) => void>();
const undoing = new Set<number>();
/** The task on screen, as App last said. */
let shown: number | null = null;

const NONE: readonly DraftRemoval[] = [];

function emit(taskId: number): void {
  for (const cb of [...listeners]) {
    try {
      cb(taskId);
    } catch {
      /* a broken subscriber must not stall the others */
    }
  }
}

/** Told the task whose removals changed. */
export function onDraftRemovals(cb: (taskId: number) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** A task's removals, oldest first. The same array until they change. */
export function draftRemovalsOf(taskId: number): readonly DraftRemoval[] {
  return byTask.get(taskId) ?? NONE;
}

/** The session removed this draft (githubGate.ts). */
export function noteDraftRemoved(removal: DraftRemoval): void {
  const taskId = removal.row.taskId;
  const rest = (byTask.get(taskId) ?? []).filter((r) => r.row.id !== removal.row.id);
  byTask.set(taskId, [...rest, removal]);
  emit(taskId);
}

/** Forget a task's removals: it was left, or its review was submitted. */
export function clearDraftRemovals(taskId: number): void {
  if (!byTask.delete(taskId)) return;
  emit(taskId);
}

/**
 * The task on screen changed (App). Leaving one clears its removals: they
 * were there to be seen while it was open.
 */
export function noteShownTask(taskId: number | null): void {
  if (shown === taskId) return;
  const left = shown;
  shown = taskId;
  if (left !== null) clearDraftRemovals(left);
}

/**
 * Put the draft back as it was. The line goes once the row is back; a
 * failed write keeps it, so Undo can be pressed again, and rethrows.
 */
export async function undoDraftRemoval(taskId: number, commentId: number): Promise<void> {
  const r = (byTask.get(taskId) ?? []).find((x) => x.row.id === commentId);
  // One Undo at a time: a second press would insert the same id twice.
  if (!r || undoing.has(commentId)) return;
  undoing.add(commentId);
  try {
    await restoreComment(r.row);
  } finally {
    undoing.delete(commentId);
  }
  const rest = (byTask.get(taskId) ?? []).filter((x) => x.row.id !== commentId);
  if (rest.length === 0) byTask.delete(taskId);
  else byTask.set(taskId, rest);
  emit(taskId);
}

// ---------------------------------------------------------------------------
// Drafts open for editing: the session never removes one (#427)
// ---------------------------------------------------------------------------

/** Comment id -> how many edit boxes have it open now. */
const editing = new Map<number, number>();

/**
 * An edit box opened on this comment (the Diff mode's box, the File mode's,
 * a reply's): while held, `delete_github_draft` refuses it, so what is being
 * typed is never lost under the owner. Returns the release; call it once.
 */
export function holdDraftEdit(commentId: number): () => void {
  editing.set(commentId, (editing.get(commentId) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const n = (editing.get(commentId) ?? 1) - 1;
    if (n <= 0) editing.delete(commentId);
    else editing.set(commentId, n);
  };
}

/** Whether any edit box has this comment open. */
export function isDraftBeingEdited(commentId: number): boolean {
  return editing.has(commentId);
}

/** Test seam: forget everything. */
export function __resetDraftRemovals(): void {
  byTask.clear();
  listeners.clear();
  undoing.clear();
  editing.clear();
  shown = null;
}
