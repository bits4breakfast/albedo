/**
 * Where a past session can be resumed when the folder it ran in is gone.
 *
 * A session records its cwd and its branch. When the cwd has been deleted --
 * typically a worktree removed by hand -- the branch usually still exists, so
 * there are two better answers than "pick some folder":
 *
 *  - **recreate**: `git worktree add <old path> <branch>`. Every path in the
 *    conversation lines up again, which no other folder can promise.
 *  - **elsewhere**: the branch is checked out in another worktree right now
 *    (often the main checkout). git refuses a second checkout of a branch, so
 *    this rules out recreating and becomes the suggestion instead.
 *  - **switch the main checkout**: `git switch <branch>` in the repo's main
 *    working tree, for someone who would rather not have a worktree at all.
 *    That folder is the user's own, so it is offered only when it has no
 *    uncommitted changes, checked again right before switching.
 *
 * The decision is pure ({@link planResumePlace}); the probing around it is not.
 *
 * Owner: worktree workstream (M3).
 */

import type { Project } from '../types';
import { findTaskByWorktreePath } from '../db';
import { listProjects } from '../db/projects';
import {
  GitError,
  createWorktree,
  git,
  gitOk,
  listWorktreesDetailed,
  uncommittedChanges,
  type ParsedWorktree,
} from './worktree';
import { expandTilde, normalizePath } from './reconcile';
import { isValidRefName } from './slug';

export interface ResumePlacePlan {
  /** The repository the missing folder belonged to. */
  repoPath: string;
  branch: string;
  /** Offer to recreate the worktree at the old path. */
  recreate: boolean;
  /** A live worktree with `branch` checked out, or null. */
  elsewhere: string | null;
  /**
   * The repo's main working tree, which could be switched to `branch`. Null
   * when the branch is checked out elsewhere (git would refuse) or the repo
   * has no main working tree. `dirty` is its uncommitted-change count, null
   * when unreadable; only 0 makes the switch available.
   */
  main: { path: string; current: string | null; dirty: number | null } | null;
  /**
   * git still has a registration whose folder is gone -- for the old path, or
   * one still holding the branch -- and `worktree add` refuses both until they
   * are pruned ("is already used by worktree at ...").
   */
  needsPrune: boolean;
  /** Base branch to record on the task, so its unmerged count means something. */
  baseBranch: string;
}

/** Decide what to offer. `worktrees` is `git worktree list` for the repo. */
export function planResumePlace(o: {
  cwd: string;
  repoPath: string;
  branch: string | null;
  branchExists: boolean;
  worktrees: readonly ParsedWorktree[];
  baseBranch: string | null;
  /** Uncommitted changes in the main working tree; null when unreadable. */
  mainDirty?: number | null;
}): ResumePlacePlan | null {
  const branch = o.branch;
  // A detached session records `HEAD`, which names no branch to check out.
  if (!branch || branch === 'HEAD' || !isValidRefName(branch) || !o.branchExists) return null;
  const cwd = normalizePath(o.cwd);
  const here = (w: ParsedWorktree) => normalizePath(w.path) === cwd;
  const live = o.worktrees.find((w) => !w.prunable && !w.bare && w.branch === branch && !here(w));
  // `worktree list` always lists the main working tree first.
  const first = o.worktrees[0];
  const main =
    live === undefined && first && !first.bare && !first.prunable && !here(first)
      ? { path: first.path, current: first.branch, dirty: o.mainDirty ?? null }
      : null;
  return {
    repoPath: o.repoPath,
    branch,
    recreate: live === undefined,
    elsewhere: live?.path ?? null,
    main,
    needsPrune: o.worktrees.some((w) => w.prunable && (here(w) || w.branch === branch)),
    baseBranch: o.baseBranch || branch,
  };
}

/** The project whose worktree root holds `cwd`. Pure; `home` expands `~`. */
export function projectOwningPath(projects: readonly Project[], cwd: string, home: string): Project | null {
  const path = normalizePath(cwd);
  for (const p of projects) {
    const root = normalizePath(expandTilde(p.worktreeRoot, home));
    if (root && path.startsWith(`${root}/`)) return p;
  }
  return null;
}

/**
 * Probe a missing cwd. Null when there is nothing better to offer than a
 * folder picker: the repo cannot be identified, or the branch is gone too.
 * Never throws -- every failure means "nothing to suggest".
 */
export async function probeResumePlace(cwd: string, branch: string | null): Promise<ResumePlacePlan | null> {
  try {
    // The folder is gone, so git cannot be asked from inside it. The task that
    // ran there knows its repo; failing that, the project whose root holds it.
    const task = await findTaskByWorktreePath(cwd).catch(() => null);
    let repoPath = task?.repoPath ?? null;
    let baseBranch = task?.baseBranch ?? null;
    if (!repoPath) {
      const { homeDir } = await import('@tauri-apps/api/path');
      const project = projectOwningPath(await listProjects(), cwd, await homeDir());
      repoPath = project?.repoPath ?? null;
      baseBranch = project?.defaultBaseBranch ?? null;
    }
    if (!repoPath || !branch || !isValidRefName(branch)) return null;
    const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath);
    const worktrees = await listWorktreesDetailed(repoPath);
    const first = worktrees[0];
    let mainDirty: number | null = null;
    if (first && !first.bare && !first.prunable) {
      mainDirty = await uncommittedChanges(first.path).then((c) => c.files.length, () => null);
    }
    return planResumePlace({
      cwd,
      repoPath,
      branch,
      branchExists: exists.code === 0,
      worktrees,
      baseBranch,
      mainDirty,
    });
  } catch {
    return null;
  }
}

/**
 * `git worktree add <cwd> <branch>`, pruning first when git still has the old
 * path registered. Prune drops only registrations whose folder is gone, which
 * is what archiving runs as well.
 */
export async function recreateWorktree(plan: ResumePlacePlan, cwd: string): Promise<void> {
  if (plan.needsPrune) await gitOk(['worktree', 'prune'], plan.repoPath);
  await createWorktree({
    repoPath: plan.repoPath,
    branch: plan.branch,
    baseBranch: plan.baseBranch,
    path: cwd,
    useExistingBranch: true,
  });
}

/**
 * `git switch <branch>` in the main working tree. Refuses unless it is clean
 * *now*: the dialog's count is from when it opened, and this folder is the
 * user's own, so nothing in it may be carried onto another branch unasked.
 */
export async function switchMainCheckout(plan: ResumePlacePlan): Promise<string> {
  const main = plan.main;
  if (!main) throw new Error('This repository has no main checkout to switch.');
  const changes = await uncommittedChanges(main.path);
  if (changes.files.length > 0) {
    throw new GitError({
      args: ['switch', plan.branch],
      cwd: main.path,
      code: null,
      stdout: '',
      stderr: `${main.path} now has ${changes.files.length} uncommitted change(s). Commit or stash them first; nothing was switched.`,
    });
  }
  await gitOk(['switch', plan.branch], main.path);
  return main.path;
}
