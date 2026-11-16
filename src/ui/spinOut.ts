/**
 * The link between a task and what it spun out (#332).
 *
 * Two readings of one fact, `tasks.spun_from_task_id`:
 *
 *   - the new task's bar shows "from <source>" ({@link spunFromLink});
 *   - the source's transcript says, on the `mcp__albedo__request_session`
 *     call, what the request became ({@link spinOutStatus}): still in the
 *     task list, spun out as which task, or not spun out.
 *
 * A call carries no request id (Claude Code writes the tool's input, not
 * the server's line), so it is matched to its request by the asking task and
 * the request's title and brief (`requestKey`), which the server keeps as the
 * call gave them, trimmed. What became of it is the request queue's record
 * (requestQueue.ts, `SessionOutcome`); a task spun out of this one under the
 * same title answers when that record is gone (another machine, a cleared
 * store, a request older than the record). Otherwise nothing is said: an
 * expired request, or one from before #332, has no status to show.
 */

import { createContext } from 'react';
import type { Task } from '../types';
import { requestKey, type QueuedRequest, type SessionOutcome } from './requestQueue';

/** Claude Code's name for the tool: `mcp__<server>__<tool>` (sessionSpawn.ts MCP_TOOLS). */
export const REQUEST_SESSION_TOOL = 'mcp__albedo__request_session';

export type SpinOutStatus =
  | { kind: 'pending' }
  | { kind: 'denied' }
  /** `live`: the task is still in the list, so the title is a link to it. */
  | { kind: 'spun'; taskId: number; title: string; live: boolean };

/** What the call's input is read for: title and brief, as Claude gave them. */
export interface RequestCall {
  title: unknown;
  prompt: unknown;
}

/**
 * What became of the request `call` made from task `askingTaskId`, or null
 * when nothing is known. `tasks` includes archived ones when the caller has
 * them; an archived or unknown task is named without a link.
 */
export function spinOutStatus(
  call: RequestCall,
  askingTaskId: number,
  pending: readonly QueuedRequest[],
  outcomes: readonly SessionOutcome[],
  tasks: readonly Pick<Task, 'id' | 'title' | 'status' | 'spunFromTaskId'>[],
): SpinOutStatus | null {
  if (typeof call.title !== 'string' || typeof call.prompt !== 'string') return null;
  const key = requestKey(call.title, call.prompt);
  const waiting = pending.some(
    (r) => r.tool === 'request_session' && r.taskId === askingTaskId && requestKey(r.title, r.prompt) === key,
  );
  if (waiting) return { kind: 'pending' };

  const named = (id: number, fallback: string): SpinOutStatus => {
    const t = tasks.find((x) => x.id === id);
    return { kind: 'spun', taskId: id, title: t?.title ?? fallback, live: !!t && t.status !== 'archived' };
  };
  // The latest decision wins: a request asked again after a denial is a new one.
  const decided = [...outcomes].reverse().find((o) => o.taskId === askingTaskId && o.key === key);
  if (decided) {
    return decided.outcome === 'denied' || decided.spunTaskId === null
      ? { kind: 'denied' }
      : named(decided.spunTaskId, decided.spunTitle ?? '');
  }
  const title = call.title.trim();
  const spun = tasks.find((t) => t.spunFromTaskId === askingTaskId && t.title.trim() === title);
  return spun ? named(spun.id, spun.title) : null;
}

/**
 * The new task's "from <source>" chip, or null when it was not spun out or
 * the source's title is unknown (deleted, and not in `tasks`). `live` is
 * false for an archived source: named, greyed, not a link.
 */
export function spunFromLink(
  task: Pick<Task, 'spunFromTaskId'>,
  tasks: readonly Pick<Task, 'id' | 'title' | 'status'>[],
): { taskId: number; title: string; live: boolean } | null {
  if (task.spunFromTaskId === null) return null;
  const source = tasks.find((t) => t.id === task.spunFromTaskId);
  if (!source) return null;
  return { taskId: source.id, title: source.title, live: source.status !== 'archived' };
}

/** What the transcript's request chips read; provided by the shell around a task's pane. */
export interface SpinOutLookup {
  /** The status for a call made from the pane's task, or null. */
  statusOf: (call: RequestCall) => SpinOutStatus | null;
  /** Show a task (revealTask). */
  openTask: (taskId: number) => void;
}

export const SpinOutContext = createContext<SpinOutLookup | null>(null);
