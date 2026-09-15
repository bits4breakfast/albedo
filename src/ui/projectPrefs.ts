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

const LAST_PROJECT_KEY = 'albedo.worktree.lastProjectId';

/**
 * The project to preselect, or null. Every access is wrapped: a locked-down
 * WebView throws on `localStorage` rather than returning null, and a remembered
 * preference is never worth failing a dialog over.
 */
export function readLastProjectId(): number | null {
  try {
    const raw = localStorage.getItem(LAST_PROJECT_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Remember a project as the next default. Best effort, never throws. */
export function writeLastProjectId(id: number): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, String(id));
  } catch {
    // Remembering the last project is a nicety, not a requirement.
  }
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
const HIDDEN_PROJECTS_KEY = 'albedo.shell.hiddenProjects';

export function readHiddenProjectIds(): number[] {
  try {
    const raw = localStorage.getItem(HIDDEN_PROJECTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : [];
  } catch {
    return [];
  }
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
  try {
    localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify(next));
  } catch {
    // View state; not worth failing the dialog over.
  }
  return next;
}
