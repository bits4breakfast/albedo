/**
 * Which transcript row offers Try Again (#338): the API error the task's last
 * turn stopped on, and only that one. An error further up was followed by more
 * work and is history; it is drawn the same, without the button. Set by
 * TranscriptPane, read by MessageRow's error line.
 */

import { createContext } from 'react';
import type { Message, Task, TaskStatus } from '../../types';
import { apiErrorTail } from '../../capture/status';

export interface ApiErrorRetry {
  /** The error row's id. */
  messageId: number;
  task: Pick<Task, 'id' | 'status'>;
}

export const ApiErrorRetryContext = createContext<ApiErrorRetry | null>(null);

/**
 * The row that carries Try Again, read the way the task list's Stopped on an
 * Error is (`lastApiError`): the session's own thread, subagents left out,
 * and only while the task is idle. Null otherwise.
 */
export function apiErrorRetryOf(
  messages: readonly Message[],
  taskId: number | null,
  sessionId: string | null,
  status: TaskStatus | null,
): ApiErrorRetry | null {
  if (taskId === null || status !== 'idle') return null;
  const main = messages.filter((m) => m.agentId === null && (sessionId === null || m.sessionId === sessionId));
  const row = apiErrorTail(main);
  return row === null ? null : { messageId: row.id, task: { id: taskId, status } };
}
