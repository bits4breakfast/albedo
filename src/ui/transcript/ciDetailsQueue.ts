/**
 * Fetch a queued CI failure's details, once (#280, step 2).
 *
 * The PR watch (`ciNotice.ts` `observeCi`) calls this for a task whose queued
 * failure has not been asked about yet (`ciDetailsWanted`). It reads the
 * task's project for its setting:
 *   - name and link only (or no project): the item is marked `none` and
 *     stays as step 1 drew it;
 *   - otherwise it is marked `fetching` -- the item is already listed, and
 *     says so -- and the answer, or why there is none, replaces the mark
 *     within 30 s (`fetchCiDetails`).
 *
 * One fetch per failure at a time; an answer for a failure that has since
 * changed or left is dropped by the store (`setQueuedCiDetails`). Nothing
 * here sends: the details wait on the item like everything else in it.
 */

import type { Project, Task } from '../../types';
import { fetchCiDetails } from '../../gh/ciDetailsRun';
import type { CiDetailsState, FailureForDetails } from '../../gh/ciDetails';
import type { PrStatus } from '../../gh/prStatus';
import { headKey } from '../../gh/ciTransition';
import { detailsKey, failingChecks, setQueuedCiDetails, type QueuedCiFailure } from './ciFailure';

export type DetailsTask = Pick<Task, 'id' | 'projectId' | 'worktreePath' | 'repoPath'>;

export interface DetailsDeps {
  getProject: (id: number) => Promise<Project | null>;
  fetch: (project: Project, cwd: string, failure: QueuedCiFailure) => Promise<CiDetailsState>;
}

const productionDeps: DetailsDeps = {
  // Lazily, so a test of the PR watch never loads the SQL plugin.
  getProject: async (id) => (await import('../../db/projects')).getProject(id),
  fetch: (project, cwd, failure) => fetchCiDetails(project, cwd, failure),
};

const inFlight = new Set<string>();

/** Resolves once the item holds its answer (or the item has moved on). */
export async function fetchQueuedCiDetails(
  task: DetailsTask,
  failure: QueuedCiFailure,
  deps: DetailsDeps = productionDeps,
): Promise<void> {
  const key = detailsKey(failure);
  const flight = `${task.id}\n${key}`;
  if (inFlight.has(flight)) return;
  inFlight.add(flight);
  try {
    let project: Project | null = null;
    try {
      project = task.projectId === null ? null : await deps.getProject(task.projectId);
    } catch (err) {
      console.warn('[ci details] could not read the project; name and link only', err);
    }
    if (!project || project.ciDetails === 'link') {
      setQueuedCiDetails(task.id, key, { state: 'none' });
      return;
    }
    setQueuedCiDetails(task.id, key, { state: 'fetching' });
    // The task's own folder: the main checkout when it has no worktree.
    const cwd = task.worktreePath || task.repoPath;
    let details: CiDetailsState;
    try {
      details = await deps.fetch(project, cwd, failure);
    } catch (err) {
      details = { state: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }
    setQueuedCiDetails(task.id, key, details);
  } finally {
    inFlight.delete(flight);
  }
}

/** Test seam. */
export function __resetCiDetailsQueue(): void {
  inFlight.clear();
}

// ---------------------------------------------------------------------------
// The Projects dialog's "Test on the Last Failure"
// ---------------------------------------------------------------------------

export interface LastFailure {
  task: Pick<Task, 'id' | 'title' | 'worktreePath' | 'repoPath'>;
  failure: FailureForDetails;
}

/**
 * The failure a command is tried on: the project's most recently queued one,
 * else the failing checks of any of its tasks' PRs as the PR store last read
 * them (a failure already sent or removed is no longer queued, but its PR
 * still fails). Null when none of the project's tasks has one at hand.
 */
export function lastFailureIn(
  tasks: readonly Pick<Task, 'id' | 'title' | 'worktreePath' | 'repoPath' | 'kind' | 'status'>[],
  queued: (taskId: number) => QueuedCiFailure | null,
  prOf: (taskId: number) => PrStatus | null | undefined,
): LastFailure | null {
  const live = tasks.filter((t) => t.kind !== 'chat' && t.status !== 'archived');
  let best: { task: (typeof live)[number]; item: QueuedCiFailure } | null = null;
  for (const task of live) {
    const item = queued(task.id);
    if (item && (!best || item.queuedAt > best.item.queuedAt)) best = { task, item };
  }
  if (best) return { task: best.task, failure: best.item };
  for (const task of live) {
    const pr = prOf(task.id);
    if (!pr || pr.checks.kind !== 'failing') continue;
    const checks = failingChecks(pr);
    if (checks.length > 0) return { task, failure: { prNumber: pr.number, sha: headKey(pr), checks } };
  }
  return null;
}
