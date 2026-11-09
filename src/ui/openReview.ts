/**
 * Open a pull request for review in Albedo (#287): a worktree on its head, a
 * task that remembers which PR it is for, and nothing else. The session
 * starts when the task's terminal does, told that it explains and changes
 * nothing (sessionSpawn.ts, reviewSystemPrompt).
 *
 * A PR already open as a review task is that task: callers look it up with
 * {@link reviewTaskFor} first, so one PR is never checked out twice.
 */

import type { Project, Task } from '../types';
import { createTask } from '../db';
import { composeWorktreePath, createWorktree, undoCreateWorktree } from '../git/worktree';
import { fetchReviewHead, parsePrUrl } from '../git/reviewCheckout';
import type { ReviewPr } from '../gh/reviewRequests';

/** The live (not archived) review task for `url`, if there is one. */
export function reviewTaskFor(tasks: readonly Task[], url: string): Task | null {
  return tasks.find((t) => t.reviewUrl === url && t.status !== 'archived') ?? null;
}

async function homeDir(): Promise<string> {
  const { homeDir: home } = await import('@tauri-apps/api/path');
  return home();
}

/**
 * Fetch the PR's head into `review/<n>`, add a worktree for it under the
 * project's worktree root (`review-<n>`), and record the task. Throws with
 * git's words; a worktree whose task could not be saved is removed again.
 */
export async function openReviewTask(project: Project, pr: ReviewPr, home?: string): Promise<Task> {
  const ref = parsePrUrl(pr.url);
  if (!ref) throw new Error(`Not a pull request link Albedo can check out: ${pr.url}`);
  const branch = await fetchReviewHead(project.repoPath, ref, pr.baseBranch);
  const path = composeWorktreePath(project.worktreeRoot, `review-${ref.number}`, home ?? (await homeDir()));
  const created = {
    repoPath: project.repoPath,
    baseBranch: pr.baseBranch,
    branch,
    path,
    // Fetched just now into review/<n>: checked out as it is, never cut.
    useExistingBranch: true,
  };
  await createWorktree(created);
  try {
    return await createTask({
      title: pr.title,
      projectId: project.id,
      repoPath: project.repoPath,
      baseBranch: pr.baseBranch,
      branch,
      worktreePath: path,
      // Albedo made the worktree and the branch: both are its to remove.
      ownsWorktree: true,
      createdBranch: true,
      kind: 'work',
      reviewUrl: pr.url,
    });
  } catch (e) {
    const leftover = await undoCreateWorktree(created);
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`The review could not be saved:\n${why}${leftover ? `\n\n${leftover}` : ''}`);
  }
}
