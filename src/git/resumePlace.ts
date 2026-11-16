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
 * When the branch is gone too -- typically worktree and branch removed after
 * the PR merged -- the worktree can still be put back at the old path (#395):
 *
 *  - **from origin**: the branch is still on the remote (one branch fetched,
 *    nothing else), so a local branch is cut from it, tracking it.
 *  - **from the base**: gone from the remote too, so a new branch of the same
 *    name is cut from the project's base branch, freshly fetched. The earlier
 *    work is in it only if it was merged.
 *
 * Neither is offered while something occupies the old path.
 *
 * The decision is pure ({@link planResumePlace}); the probing around it is not.
 *
 * Owner: worktree workstream (M3).
 */

import type { Project } from '../types';
import { findTaskByWorktreePath } from '../db';
import { listProjects } from '../db/projects';
import {
  baseFreshness,
  createWorktree,
  cutPoint,
  defaultBranchOf,
  fetchRemoteBranch,
  gitOk,
  listWorktreesDetailed,
  probePath,
  refExists,
  switchCleanCheckout,
  uncommittedChanges,
  type ParsedWorktree,
} from './worktree';
import { expandTilde, normalizePath } from './reconcile';
import { isValidRefName } from './slug';

/** The remote a gone branch is looked for on. */
export const RESUME_REMOTE = 'origin';

export interface ResumePlacePlan {
  /** The repository the missing folder belonged to. */
  repoPath: string;
  branch: string;
  /** Offer to recreate the worktree at the old path. */
  recreate: boolean;
  /**
   * Where the recreated worktree's branch comes from: `local`, the branch as
   * it is; `remote`, a new local branch tracking `startPoint`
   * (`origin/<branch>`); `base`, a new branch cut from `startPoint` -- the
   * base branch, or its upstream when that is ahead (see cutPoint).
   */
  source: 'local' | 'remote' | 'base';
  /** What a `remote` or `base` worktree is cut from; null for `local`. */
  startPoint: string | null;
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
  /**
   * Base branch to record on the task, so its unmerged count means something.
   * Null when none is known; never the task's own branch (see defaultBranchOf).
   */
  baseBranch: string | null;
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
  /** The branch is gone locally: whether fetching it from origin worked. */
  onRemote?: boolean;
  /**
   * The branch is gone here and on origin: what a new one would be cut from
   * (the base, or its fetched upstream). Null when the base cannot be found.
   */
  baseStart?: string | null;
  /** Something is at the old path now, whatever git says. */
  pathOccupied?: boolean;
}): ResumePlacePlan | null {
  const branch = o.branch;
  // A detached session records `HEAD`, which names no branch to check out.
  if (!branch || branch === 'HEAD' || !isValidRefName(branch)) return null;
  const cwd = normalizePath(o.cwd);
  const here = (w: ParsedWorktree) => normalizePath(w.path) === cwd;
  const baseBranch = o.baseBranch && o.baseBranch !== branch ? o.baseBranch : null;
  const needsPrune = o.worktrees.some((w) => w.prunable && (here(w) || w.branch === branch));
  if (!o.branchExists) return planGoneBranch(o, branch, here, baseBranch, needsPrune);
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
    source: 'local',
    startPoint: null,
    elsewhere: live?.path ?? null,
    main,
    needsPrune,
    baseBranch,
  };
}

/**
 * The branch is gone locally. Only a worktree at the old path is offered --
 * that is the point of it -- so nothing may be there now: no folder, and no
 * live registration. No main-checkout switch: there is no branch to switch to.
 */
function planGoneBranch(
  o: { repoPath: string; worktrees: readonly ParsedWorktree[]; onRemote?: boolean; baseStart?: string | null; pathOccupied?: boolean },
  branch: string,
  here: (w: ParsedWorktree) => boolean,
  baseBranch: string | null,
  needsPrune: boolean,
): ResumePlacePlan | null {
  if (o.pathOccupied) return null;
  if (o.worktrees.some((w) => here(w) && !w.prunable)) return null;
  // git refuses `-b` for a branch a live worktree still names.
  if (o.worktrees.some((w) => w.branch === branch && !w.prunable)) return null;
  const remote = o.onRemote === true;
  if (!remote && (!baseBranch || !o.baseStart)) return null;
  return {
    repoPath: o.repoPath,
    branch,
    recreate: true,
    source: remote ? 'remote' : 'base',
    startPoint: remote ? `${RESUME_REMOTE}/${branch}` : (o.baseStart ?? null),
    elsewhere: null,
    main: null,
    needsPrune,
    baseBranch,
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
 * folder picker: the repo cannot be identified, or the old path cannot take a
 * worktree. Never throws -- every failure means "nothing to suggest".
 *
 * When the branch is gone it fetches: that one branch from origin, and, when
 * origin does not have it, the base branch's upstream.
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
    // A detached session records `HEAD`: nothing to check out, nothing to fetch.
    if (!repoPath || !branch || branch === 'HEAD' || !isValidRefName(branch)) return null;
    if (!baseBranch || baseBranch === branch) baseBranch = await defaultBranchOf(repoPath);
    const exists = await refExists(repoPath, `refs/heads/${branch}`);
    const worktrees = await listWorktreesDetailed(repoPath);
    if (!exists) {
      const pathOccupied = await probePath(cwd).catch(() => false);
      if (pathOccupied) return null;
      const onRemote = await fetchRemoteBranch(repoPath, RESUME_REMOTE, branch).catch(() => false);
      const baseStart = onRemote || !baseBranch || baseBranch === branch ? null : await freshBase(repoPath, baseBranch);
      return planResumePlace({
        cwd,
        repoPath,
        branch,
        branchExists: false,
        worktrees,
        baseBranch,
        onRemote,
        baseStart,
        pathOccupied,
      });
    }
    const first = worktrees[0];
    let mainDirty: number | null = null;
    if (first && !first.bare && !first.prunable) {
      mainDirty = await uncommittedChanges(first.path).then((c) => c.files.length, () => null);
    }
    return planResumePlace({
      cwd,
      repoPath,
      branch,
      branchExists: exists,
      worktrees,
      baseBranch,
      mainDirty,
    });
  } catch {
    return null;
  }
}

/**
 * What a new branch named like the gone one is cut from: the base, fetched,
 * or its upstream when that is ahead (cutPoint). `origin/<base>` when only
 * that exists. Null when neither does.
 */
async function freshBase(repoPath: string, base: string): Promise<string | null> {
  const fresh = await baseFreshness(repoPath, base).catch(() => null);
  const start = cutPoint(base, fresh);
  if (start !== base || (await refExists(repoPath, `refs/heads/${base}`))) return start;
  const remote = `${RESUME_REMOTE}/${base}`;
  if (await fetchRemoteBranch(repoPath, RESUME_REMOTE, base).catch(() => false)) return remote;
  return (await refExists(repoPath, `refs/remotes/${remote}`)) ? remote : null;
}

/**
 * Put the worktree back at `cwd`, pruning first when git still has the old
 * path registered. Prune drops only registrations whose folder is gone, which
 * is what archiving runs as well.
 *
 * - `local`: `git worktree add <cwd> <branch>`.
 * - `remote`: `git worktree add --track -b <branch> <cwd> origin/<branch>`.
 * - `base`: `git worktree add --no-track -b <branch> <cwd> <start>`.
 */
export async function recreateWorktree(plan: ResumePlacePlan, cwd: string): Promise<void> {
  if (plan.needsPrune) await gitOk(['worktree', 'prune'], plan.repoPath);
  if (plan.source === 'local') {
    await createWorktree({
      repoPath: plan.repoPath,
      branch: plan.branch,
      // Unused with useExistingBranch, but the option is required.
      baseBranch: plan.baseBranch ?? plan.branch,
      path: cwd,
      useExistingBranch: true,
    });
    return;
  }
  if (!plan.startPoint) throw new Error(`Nothing to make ${plan.branch} from.`);
  if (plan.source === 'remote') {
    await createWorktree({ repoPath: plan.repoPath, branch: plan.branch, baseBranch: plan.startPoint, path: cwd, track: true });
    return;
  }
  await createWorktree({
    repoPath: plan.repoPath,
    branch: plan.branch,
    baseBranch: plan.baseBranch ?? plan.startPoint,
    startPoint: plan.startPoint,
    path: cwd,
  });
}

/** `git switch <branch>` in the main working tree. See {@link switchCleanCheckout}. */
export async function switchMainCheckout(plan: ResumePlacePlan): Promise<string> {
  const main = plan.main;
  if (!main) throw new Error('This repository has no main checkout to switch.');
  await switchCleanCheckout({ path: main.path, branch: plan.branch });
  return main.path;
}
