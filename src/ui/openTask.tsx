/**
 * The app-wide "open this task" entry point, for renderers that name a task
 * without knowing how the shell selects one -- a message from another session
 * names the session that sent it. The shell provides it, the way it provides
 * `FileOpenContext`; everyone else calls `useTaskOpener()`.
 */

import { createContext, useContext } from 'react';

export interface TaskOpener {
  /** Whether the task is one the shell can show (not archived, not deleted). */
  has(taskId: number): boolean;
  /** Select it, moving to its project tab when that tab is open. */
  open(taskId: number): void;
}

/** Outside a provider (a test) nothing is openable, so nothing is a link. */
export const TaskOpenContext = createContext<TaskOpener>({ has: () => false, open: () => {} });
TaskOpenContext.displayName = 'TaskOpenContext';

export function useTaskOpener(): TaskOpener {
  return useContext(TaskOpenContext);
}
