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
 *  - **from origin**: the branch is still on the remote (asked with
 *    `ls-remote`, then that one branch fetched), so a local branch is cut from
 *    it, tracking it. When origin cannot be reached, the last fetch's copy of
 *    it serves, if there is one.
 *  - **from the base**: origin answered and has no such branch, so a new
 *    branch of the same name is cut from the project's base branch, freshly
 *    fetched. The earlier work is in it only if it was merged. When origin
 *    could not be asked and there is no copy, this is still offered but not
 *    chosen: the branch may well be there.
 *
 * Neither is offered while something occupies the old path, nor for a folder
 * that was not a worktree of its own (a session started in a subfolder).
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
  git,
  gitOk,
  listWorktreesDetailed,
  probePath,
  refExists,
  remoteBranchState,
  switchCleanCheckout,
  uncommittedChanges,
  type ParsedWorktree,
  type RemoteBranchState,
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
  /**
   * The branch is gone locally: what origin said about it. `unknown` when it
   * could not be asked -- then `remote` cuts from the last fetch's copy, and
   * `base` must not be described as "gone from origin". Null for `local`.
   */
  origin: RemoteBranchState | null;
  /**
   * Whether recreating is chosen up front. Not for `base` while origin could
   * not be asked: the branch may still be there, and a new one would hide it.
   */
  preselect: boolean;
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
  /** The branch is gone locally: what origin said about it (see remoteBranchState). */
  origin?: RemoteBranchState;
  /** `refs/remotes/origin/<branch>` exists, current or from the last fetch. */
  trackingRef?: boolean;
  /**
   * What a new branch of the same name would be cut from (the base, or its
   * fetched upstream). Null when the base cannot be found.
   */
  baseStart?: string | null;
  /** Something is at the old path now, whatever git says. */
  pathOccupied?: boolean;
  /**
   * The old path is one Albedo can put a worktree at: a task's own worktree,
   * or exactly one level under the project's worktree root -- never a
   * subfolder a session happened to start in.
   */
  ownedPath?: boolean;
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
    origin: null,
    preselect: live === undefined,
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
  o: {
    repoPath: string;
    worktrees: readonly ParsedWorktree[];
    origin?: RemoteBranchState;
    trackingRef?: boolean;
    baseStart?: string | null;
    pathOccupied?: boolean;
    ownedPath?: boolean;
  },
  branch: string,
  here: (w: ParsedWorktree) => boolean,
  baseBranch: string | null,
  needsPrune: boolean,
): ResumePlacePlan | null {
  if (o.ownedPath !== true || o.pathOccupied) return null;
  if (o.worktrees.some((w) => here(w) && !w.prunable)) return null;
  // git refuses `-b` for a branch a live worktree still names.
  if (o.worktrees.some((w) => w.branch === branch && !w.prunable)) return null;
  const origin = o.origin ?? 'unknown';
  const shared = { repoPath: o.repoPath, branch, recreate: true, origin, elsewhere: null, main: null, needsPrune, baseBranch };
  // Origin has it -- or could not be asked, and the last fetch left a copy.
  if (origin === 'present' || (origin === 'unknown' && o.trackingRef === true)) {
    return { ...shared, source: 'remote', startPoint: `${RESUME_REMOTE}/${branch}`, preselect: true };
  }
  if (!baseBranch || !o.baseStart) return null;
  return { ...shared, source: 'base', startPoint: o.baseStart, preselect: origin === 'absent' };
}

/** Whether `cwd` is exactly one level under `root`. Pure; `home` expands `~`. */
export function directlyUnder(root: string, cwd: string, home: string): boolean {
  const r = normalizePath(expandTilde(root, home));
  const path = normalizePath(cwd);
  if (!r || !path.startsWith(`${r}/`)) return false;
  const rest = path.slice(r.length + 1);
  return rest.length > 0 && !rest.includes('/');
}

/**
 * `origin/main` -> `main`: a base recorded with its remote names the same
 * branch, and freshBase wants the local name. Longest remote first, because a
 * remote may itself contain a slash. Pure.
 */
export function stripRemote(base: string, remotes: readonly string[]): string {
  const remote = [...remotes]
    .sort((a, b) => b.length - a.length)
    .find((r) => base.startsWith(`${r}/`) && base.length > r.length + 1);
  return remote ? base.slice(remote.length + 1) : base;
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
 * When the branch is gone it asks origin about that one branch (fetching it
 * when there), and otherwise fetches the base branch's upstream. One such
 * probe per repo, branch and base runs at a time (probeGoneBranch).
 */
export async function probeResumePlace(cwd: string, branch: string | null): Promise<ResumePlacePlan | null> {
  try {
    // The folder is gone, so git cannot be asked from inside it. The task that
    // ran there knows its repo; failing that, the project whose root holds it.
    const task = await findTaskByWorktreePath(cwd).catch(() => null);
    let repoPath = task?.repoPath ?? null;
    let baseBranch = task?.baseBranch ?? null;
    let projectRoot: { root: string; home: string } | null = null;
    const findProject = async () => {
      const { homeDir } = await import('@tauri-apps/api/path');
      const home = await homeDir();
      const project = projectOwningPath(await listProjects(), cwd, home);
      if (project) projectRoot = { root: project.worktreeRoot, home };
      return project;
    };
    if (!repoPath) {
      const project = await findProject();
      repoPath = project?.repoPath ?? null;
      baseBranch = project?.defaultBaseBranch ?? null;
    }
    // A detached session records `HEAD`: nothing to check out, nothing to fetch.
    if (!repoPath || !branch || branch === 'HEAD' || !isValidRefName(branch)) return null;
    if (!baseBranch || baseBranch === branch) baseBranch = await defaultBranchOf(repoPath);
    const exists = await refExists(repoPath, `refs/heads/${branch}`);
    const worktrees = await listWorktreesDetailed(repoPath);
    if (!exists) {
      // A worktree goes back only where one was: the folder of a task that
      // owned its worktree there, or one level under the project's worktree
      // root. A matched task alone is not enough -- an earlier Past Sessions
      // resume may have recorded a subfolder a session started in.
      const taskOwned =
        task !== null && task.ownsWorktree === true && normalizePath(task.worktreePath) === normalizePath(cwd);
      if (!taskOwned) {
        if (!projectRoot) await findProject().catch(() => null);
        const at = projectRoot as { root: string; home: string } | null;
        if (!at || !directlyUnder(at.root, cwd, at.home)) return null;
      }
      const pathOccupied = await probePath(cwd).catch(() => false);
      if (pathOccupied) return null;
      const remotes = await git(['remote'], repoPath).then(
        (r) => (r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []),
        () => [],
      );
      // `origin/main` names main -- unless a local branch is really called
      // that (a remote named `feature` must not turn `feature/x` into `x`).
      const base =
        baseBranch && !(await refExists(repoPath, `refs/heads/${baseBranch}`).catch(() => false))
          ? stripRemote(baseBranch, remotes)
          : baseBranch;
      const gone = await probeGoneBranch(repoPath, branch, base && base !== branch ? base : null);
      return planResumePlace({
        cwd,
        repoPath,
        branch,
        branchExists: false,
        worktrees,
        baseBranch,
        ...gone,
        pathOccupied,
        ownedPath: true,
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

interface GoneBranchProbe {
  origin: RemoteBranchState;
  trackingRef: boolean;
  baseStart: string | null;
}

/**
 * One probe per repo, branch and base at a time: selecting a row again while
 * its probe is still out reuses that probe instead of asking origin twice.
 */
const goneProbes = new Map<string, Promise<GoneBranchProbe>>();

/** Ask origin about a gone branch and, unless it can be had from there, find the base. */
function probeGoneBranch(repoPath: string, branch: string, base: string | null): Promise<GoneBranchProbe> {
  const key = [repoPath, branch, base ?? ''].join('\0');
  const running = goneProbes.get(key);
  if (running) return running;
  const probe = (async (): Promise<GoneBranchProbe> => {
    const origin = await remoteBranchState(repoPath, RESUME_REMOTE, branch).catch((): RemoteBranchState => 'unknown');
    const trackingRef =
      origin === 'present' ||
      (origin === 'unknown' &&
        (await refExists(repoPath, `refs/remotes/${RESUME_REMOTE}/${branch}`).catch(() => false)));
    const fromRemote = origin !== 'absent' && trackingRef;
    const baseStart = fromRemote || !base ? null : await freshBase(repoPath, base).catch(() => null);
    return { origin, trackingRef, baseStart };
  })().finally(() => goneProbes.delete(key));
  goneProbes.set(key, probe);
  return probe;
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
