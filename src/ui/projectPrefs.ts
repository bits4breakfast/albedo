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
