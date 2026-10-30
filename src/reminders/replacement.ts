/**
 * A new task for a reminder whose own task is gone: archived, deleted, or on
 * a session that can no longer be resumed. Opened in the same project, and as
 * close to where the work stood as git still allows.
 *
 * ## The rule
 *
 *   1. **A chat** (recorded branch `''`): a new chat in the project's main
 *      checkout. Nothing is created or switched in git.
 *   2. **The recorded branch still exists:**
 *      - checked out in a worktree already: the new task runs there, and
 *        Albedo does not own that folder (archive will not offer to remove it);
 *      - otherwise: a new worktree with that branch checked out. Albedo owns
 *        the folder, not the branch (it was not cut for this task).
 *   3. **The branch is gone:** a new branch `reminder-<id>-<slug>` in a new
 *      worktree, cut from the recorded commit if it is still in the
 *      repository, else from the project's default base.
 *   4. **git refused any of that:** a chat in the main checkout, so the card
 *      still has somewhere to show. Logged.
 *
 * The base the new task is measured against is the project's default base
 * (`defaultBaseBranch`, else `origin/HEAD`, else `main`/`master`).
 */

import { createTask } from '../db';
import { findProjectByRepo, getProject } from '../db/projects';
import { branchNameFor, slugify } from '../git/slug';
import {
  composeWorktreePath,
  createWorktree,
  defaultBranchOf,
  git,
  listWorktreesDetailed,
  probePath,
} from '../git/worktree';
import type { Project, Reminder, Task } from '../types';

/** The new task's title: the reminder's first line, labelled. */
export function replacementTitle(r: Pick<Reminder, 'text'>): string {
  const first = r.text.trim().split('\n', 1)[0]?.trim() ?? '';
  const cut = first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first;
  return `Reminder: ${cut || 'from an earlier task'}`;
}

/** Test seam: the home directory needs the Tauri runtime. */
let homeDir: () => Promise<string> = async () => {
  const m = await import('@tauri-apps/api/path');
  return m.homeDir();
};

/** @internal for tests. */
export function __setHomeDir(next: () => Promise<string>): void {
  homeDir = next;
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  const r = await git(['rev-parse', '--verify', '--quiet', ref], repo).catch(() => null);
  return r?.code === 0;
}

async function freePath(project: Project, slug: string): Promise<string> {
  const home = await homeDir().catch(() => '');
  for (let n = 1; n <= 20; n++) {
    const path = composeWorktreePath(project.worktreeRoot, n === 1 ? slug : `${slug}-${n}`, home);
    if (!(await probePath(path).catch(() => false))) return path;
  }
  throw new Error(`no free folder for ${slug} under ${project.worktreeRoot}`);
}

function chatIn(project: Project, title: string): Promise<Task> {
  return createTask({
    title,
    projectId: project.id,
    repoPath: project.repoPath,
    baseBranch: '',
    branch: '',
    worktreePath: project.repoPath,
    ownsWorktree: false,
    createdBranch: false,
    kind: 'chat',
  });
}

async function workTask(r: Reminder, project: Project, title: string): Promise<Task> {
  const repo = project.repoPath;
  const base = project.defaultBaseBranch ?? (await defaultBranchOf(repo)) ?? 'main';
  const branch = r.branch;

  if (branch && (await refExists(repo, `refs/heads/${branch}`))) {
    const there = (await listWorktreesDetailed(repo).catch(() => [])).find((w) => w.branch === branch && !w.prunable);
    if (there) {
      return createTask({
        title, projectId: project.id, repoPath: repo, baseBranch: base, branch,
        worktreePath: there.path, ownsWorktree: false, createdBranch: false, kind: 'work',
      });
    }
    const path = await freePath(project, slugify(branch));
    await createWorktree({ repoPath: repo, baseBranch: base, branch, path, useExistingBranch: true });
    return createTask({
      title, projectId: project.id, repoPath: repo, baseBranch: base, branch,
      worktreePath: path, ownsWorktree: true, createdBranch: false, kind: 'work',
    });
  }

  const slug = slugify(`reminder-${r.id}-${r.text}`);
  const fresh = branchNameFor(slug);
  const fromSha = r.headSha !== null && (await refExists(repo, `${r.headSha}^{commit}`));
  const path = await freePath(project, slug);
  await createWorktree({
    repoPath: repo, baseBranch: base, branch: fresh, path,
    ...(fromSha ? { startPoint: r.headSha! } : {}),
  });
  return createTask({
    title, projectId: project.id, repoPath: repo, baseBranch: base, branch: fresh,
    worktreePath: path, ownsWorktree: true, createdBranch: true, kind: 'work',
  });
}

/** Opens the task, following the rule above. Throws only when there is no project. */
export async function openReplacementTask(r: Reminder): Promise<Task> {
  const project =
    (r.projectId !== null ? await getProject(r.projectId) : null) ?? (await findProjectByRepo(r.repoPath));
  if (!project) throw new Error(`reminder ${r.id}: no project for ${r.repoPath}`);
  const title = replacementTitle(r);
  if (r.branch === '') return chatIn(project, title);
  try {
    return await workTask(r, project, title);
  } catch (err) {
    console.warn(`[reminders] reminder ${r.id}: could not set up a worktree, opening a chat instead:`, err);
    return chatIn(project, title);
  }
}
