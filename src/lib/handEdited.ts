/**
 * Which files the user edited by hand, this session.
 *
 * The spec's reason for this existing is traceability: if a later diff looks
 * odd, you want to know whether a human touched the file behind the agent's
 * back. That is a question about *this* run of the app, so the set is
 * deliberately in memory only -- restarting Albedo clears it, which is exactly
 * what "for the rest of the session" means. Persisting it would turn a
 * three-week-old manual tweak into a permanent accusation.
 *
 * Keys are `taskId` plus the **worktree-relative** path, as produced by
 * `resolveInWorktree().relative`. Callers must not invent their own relative
 * form: `./src/a.ts` and `src/a.ts` would then be two different files.
 */

/** taskId -> set of worktree-relative paths. */
const edited = new Map<number, Set<string>>();

const listeners = new Set<() => void>();

function notify(): void {
  // Copy first: a listener that unsubscribes itself must not perturb iteration.
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (err) {
      // A broken subscriber must not stop the others, nor fail the save that
      // triggered this.
      console.error('handEdited: listener threw', err);
    }
  }
}

/**
 * Record that the user saved `relPath` by hand.
 *
 * Idempotent, and only fires the change notification when something actually
 * changed -- the touched-files view subscribes to this and re-renders.
 */
export function markHandEdited(taskId: number, relPath: string): void {
  if (!Number.isInteger(taskId) || typeof relPath !== 'string' || relPath.length === 0) return;
  let set = edited.get(taskId);
  if (!set) {
    set = new Set<string>();
    edited.set(taskId, set);
  }
  if (set.has(relPath)) return;
  set.add(relPath);
  notify();
}

/** True when the user saved this file by hand since the app started. */
export function isHandEdited(taskId: number, relPath: string): boolean {
  return edited.get(taskId)?.has(relPath) ?? false;
}

/**
 * Subscribe to changes. Returns an unsubscribe function.
 *
 * In-process only: one app, one window, so a module-level Set is sufficient
 * (same reasoning as `onTasksChanged` in src/db/index.ts).
 */
export function onHandEditedChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Every hand-edited path for a task, for the touched-files view. */
export function handEditedFiles(taskId: number): string[] {
  const set = edited.get(taskId);
  return set ? [...set] : [];
}

/**
 * Drop everything a task recorded. Used when a task is archived and its
 * worktree removed -- the paths no longer refer to anything.
 */
export function clearHandEdited(taskId: number): void {
  if (edited.delete(taskId)) notify();
}

/** Test seam: reset module state between cases. */
export function __resetHandEdited(): void {
  edited.clear();
  listeners.clear();
}
