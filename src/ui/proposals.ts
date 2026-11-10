/**
 * Proposed tasks (#332): the `request_session` requests waiting in the queue
 * (requestQueue.ts), shown in the task list's Proposed group rather than the
 * header's Requests popover. A proposal is not a task -- nothing exists until
 * the user approves it and presses Create in New Task -- so it has no group
 * key, no status and no place in `taskGroups.ts`.
 *
 * Pure: which project a proposal lands in, and which proposals the list shows
 * for the project tab that is active.
 */

import type { Project, Task } from '../types';
import type { QueuedRequest, SessionRequest } from './requestQueue';

/**
 * The project the new task would land in: the one the request names when it
 * is one of ours (by name, ignoring case), else the requesting task's. Null
 * when neither is known. New Task is prefilled with the same (prefillFor).
 */
export function proposalProjectId(
  req: SessionRequest,
  tasks: readonly Task[],
  projects: readonly Project[],
): number | null {
  const wanted = req.project?.toLowerCase();
  const named = wanted ? projects.find((p) => p.name.toLowerCase() === wanted) : undefined;
  return named?.id ?? tasks.find((t) => t.id === req.taskId)?.projectId ?? null;
}

/**
 * What the list is scoped to, as App's project tab bar has it: null with no
 * bar (everything shows), a project, or the "Other" tab (`project: null`),
 * which holds what belongs to no known project.
 */
export type ProposalScope = null | { project: Project | null };

/**
 * The proposals the list shows, newest first: those whose project is the
 * active tab's, as a task's row would be. With no tab bar, all of them. The
 * "Other" tab takes the ones whose project is unknown, so none is ever hidden
 * behind a tab that does not exist.
 */
export function proposalsInScope(
  items: readonly QueuedRequest[],
  scope: ProposalScope,
  tasks: readonly Task[],
  projects: readonly Project[],
): SessionRequest[] {
  const sessions = items.filter((r): r is SessionRequest => r.tool === 'request_session');
  const shown = sessions.filter((r) => {
    if (scope === null) return true;
    const id = proposalProjectId(r, tasks, projects);
    if (scope.project !== null) return id === scope.project.id;
    return id === null || !projects.some((p) => p.id === id);
  });
  // Newest first; the sort is stable, so equal times keep arrival order reversed.
  return shown.map((r, i) => ({ r, i })).sort((a, b) => b.r.at - a.r.at || b.i - a.i).map(({ r }) => r);
}

/** The first lines of a brief, for the preview. The whole text is one click away (Approve…). */
export function promptPreview(prompt: string, maxLines = 4, maxChars = 320): string {
  const lines = prompt.split('\n').slice(0, maxLines).join('\n');
  const cut = lines.length > maxChars ? `${lines.slice(0, maxChars - 1)}…` : lines;
  return cut.length < prompt.length && !cut.endsWith('…') ? `${cut}\n…` : cut;
}
