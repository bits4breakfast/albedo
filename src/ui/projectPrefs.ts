/**
 * Which project the new-task dialog should start on.
 *
 * This lives in its own module for a structural reason, not a stylistic one:
 * NewTaskDialog renders ProjectsDialog (the "no projects yet" path), so if
 * ProjectsDialog imported anything back out of NewTaskDialog the two would form
 * an import cycle — and a cycle between two modules whose default exports are
 * React components is the kind that resolves to `undefined` at render time
 * depending on which one the bundler happens to evaluate first.
 *
 * Both dialogs depend on this leaf instead, and neither depends on the other.
 *
 * Owner: worktree workstream (M3).
 */

import { idCodec, KEYS, numberListCodec, readPersisted, writePersisted } from './persisted';

/**
 * The project to preselect, or null. Never throws (see persisted.ts): a
 * remembered preference is never worth failing a dialog over.
 */
export function readLastProjectId(): number | null {
  return readPersisted(KEYS.lastProjectId, idCodec, null);
}

/** Remember a project as the next default. Best effort, never throws. */
export function writeLastProjectId(id: number): void {
  writePersisted(KEYS.lastProjectId, idCodec, id);
}

// ---------------------------------------------------------------------------
// Hidden projects (shell-owned state, mirrored here)
// ---------------------------------------------------------------------------

/**
 * Closed project tabs, written by the shell.
 *
 * **The shell owns this key and its shape.** The projects manager reads it so
 * that a hidden project is still listed — a manager that silently omits a
 * project is the UI disagreeing with the data, which is the same class of
 * problem as inventing one. Unhiding writes the array back, which is a member
 * removal, not a shape change.
 *
 * Hiding is view state only: nothing on disk moves, no status changes. Keep it
 * distinct from *archived* (out of the active list) and *deleted* (row gone).
 */
export function readHiddenProjectIds(): number[] {
  return readPersisted(KEYS.hiddenProjects, numberListCodec, []);
}

/**
 * Drop one project from the hidden set. Returns the new array.
 *
 * Writing here is not enough on its own: the shell reads this key once at
 * mount and keeps the set in React state, so a caller must also tell it — see
 * `onUnhideProject` on ProjectsDialog. Without that the tab reappears only
 * after a restart.
 */
export function unhideProjectId(id: number): number[] {
  const next = readHiddenProjectIds().filter((v) => v !== id);
  writePersisted(KEYS.hiddenProjects, numberListCodec, next);
  return next;
}
