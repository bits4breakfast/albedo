/**
 * The model a task's session should run on, when it is not the user's
 * Claude Code default.
 *
 * Kept in local storage rather than the tasks table on purpose: the schema is a
 * shared contract, and this is a per-machine preference about how to launch a
 * process. It matters on every spawn, including a resume after restart -- a
 * resumed session otherwise falls back to the default and silently switches
 * models. Every access is wrapped: storage can throw in a locked-down WebView.
 */

const key = (taskId: number) => `albedo.taskModel.${taskId}`;

/** The task's model (a catalog id or an alias like `opus`), or null for the default. */
export function getTaskModel(taskId: number): string | null {
  try {
    const v = localStorage.getItem(key(taskId));
    return v && v.trim().length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Set, or with null clear, the task's model. */
export function setTaskModel(taskId: number, model: string | null): void {
  try {
    if (model === null || model.trim() === '') localStorage.removeItem(key(taskId));
    else localStorage.setItem(key(taskId), model.trim());
  } catch {
    /* not remembered: the session simply uses the default next time */
  }
}
