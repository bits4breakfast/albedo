/**
 * Move a task between its own worktree and the repository's main checkout,
 * keeping its branch, its uncommitted changes and its conversation.
 *
 * Owner: worktree workstream (M3).
 *
 * git checks a branch out in one place at a time, so a move is always: free
 * the branch where it is, check it out where it goes. Doing that by hand left
 * the old copy behind on a detached HEAD, its Files pane counting every commit
 * as unpushed and offering a Push that could overwrite the branch with them.
 *
 *   to the main checkout:  stash -> worktree remove (or detach) -> switch -> apply
 *   to a worktree:         stash -> switch main away -> worktree add -> apply
 *
 * Uncommitted changes travel in a stash identified by its commit id, never by
 * position: the stash stack is shared by every worktree of the repo, and other
 * sessions push and pop it concurrently.
 *
 * The session is the caller's: it must be stopped before this runs (a removed
 * folder under a live `claude` breaks it) and resumed after, in the new place.
 * `claude --resume <id>` finds a session started in another folder.
 *
 * Each step that ran is undone, in reverse, if a later one fails; whatever
 * cannot be undone is named in the error.
 */

import {
  GitError,
  composeWorktreePath,
  createWorktree,
  git,
  gitOk,
  probeMainCheckout,
  removeWorktree,
  switchCleanCheckout,
  uncommittedChanges,
  type MainCheckout,
} from './worktree';
import { normalizePath } from './reconcile';
import { nameTask } from './slug';

export type MoveDirection = 'to-main' | 'to-worktree';

export interface MoveTaskInput {
  id: number;
  branch: string;
  worktreePath: string;
  ownsWorktree: boolean;
  baseBranch: string;
}

export interface MovePlan {
  direction: MoveDirection;
  branch: string;
  from: string;
  to: string;
  /** Uncommitted files in `from`, carried to `to`. */
  carry: number;
  /** to-main: what becomes of the old folder. */
  oldFolder: 'remove' | 'detach' | null;
  /** to-worktree: what the main checkout switches to, to free the branch. */
  mainBackTo: string | null;
  /**
   * to-main: false when the main checkout is on the branch already -- the
   * task's folder was left behind on a detached HEAD -- so the move only
   * points the task there and clears the old folder away.
   */
  switchMain: boolean;
  /** Why the move cannot run now. Empty means it can. */
  blockers: string[];
}

/** Everything {@link decideMove} needs, probed by {@link planMove}. */
export interface MoveFacts {
  task: MoveTaskInput;
  /** Whether the task's session is busy (running, or waiting on a prompt). */
  busy: boolean;
  /** The branch checked out where the task is, or null when detached/unreadable. */
  currentBranch: string | null;
  /** Uncommitted files where the task is; null when unreadable. */
  dirtyHere: number | null;
  main: MainCheckout | null;
  /** to-worktree: the folder the new worktree would get. */
  newWorktreePath: string | null;
  /** to-worktree: whether that folder already exists. */
  newPathTaken: boolean;
  /** to-worktree: the branch the main checkout would go back to. */
  mainBackTo: string | null;
}

/** Pure: what a move would do, and what stops it. */
export function decideMove(f: MoveFacts): MovePlan {
  const here = normalizePath(f.task.worktreePath);
  const inMain = f.main !== null && normalizePath(f.main.path) === here;
  const direction: MoveDirection = inMain ? 'to-worktree' : 'to-main';
  const blockers: string[] = [];

  // The branch already moved to the main checkout by hand, leaving this folder
  // detached: nothing for git to switch, only the task to point there.
  const alreadyThere = direction === 'to-main' && !!f.task.branch && f.main?.current === f.task.branch;

  if (f.busy) blockers.push('The session is working. Wait until it is idle: moving restarts it.');
  if (alreadyThere) {
    if (f.currentBranch === null && (f.dirtyHere ?? 0) > 0) {
      blockers.push(
        `${f.task.worktreePath} has ${f.dirtyHere} uncommitted change(s) on no branch: commit them on a branch, or discard them, first.`,
      );
    }
  } else if (!f.task.branch || f.currentBranch === null) {
    blockers.push(`${f.task.worktreePath} is not on a branch, so there is no branch to move.`);
  } else if (f.currentBranch !== f.task.branch) {
    blockers.push(`${f.task.worktreePath} is on ${f.currentBranch}, not the task's ${f.task.branch}.`);
  }
  if (f.dirtyHere === null) blockers.push(`Could not read ${f.task.worktreePath}.`);
  if (!f.main) blockers.push('This repository has no main checkout to move to or from.');

  if (direction === 'to-main' && f.main) {
    // The user's own folder: nothing in it may be carried onto another branch.
    if (f.main.dirty === null) blockers.push(`Could not read ${f.main.path}.`);
    else if (f.main.dirty > 0 && !alreadyThere) {
      blockers.push(
        `${f.main.path} has ${f.main.dirty} uncommitted change(s) of its own: commit or stash them first.`,
      );
    }
  }
  if (direction === 'to-worktree') {
    if (!f.newWorktreePath) blockers.push('No folder could be worked out for the worktree.');
    else if (f.newPathTaken) blockers.push(`${f.newWorktreePath} already exists.`);
    if (!f.mainBackTo) blockers.push('Choose the branch the main checkout goes back to.');
    else if (f.mainBackTo === f.task.branch) blockers.push('The main checkout must go back to another branch.');
  }

  return {
    direction,
    branch: f.task.branch,
    from: f.task.worktreePath,
    to: direction === 'to-main' ? (f.main?.path ?? '') : (f.newWorktreePath ?? ''),
    // Nothing to carry onto a checkout that is the branch already.
    carry: alreadyThere ? 0 : (f.dirtyHere ?? 0),
    oldFolder: direction === 'to-main' ? (f.task.ownsWorktree ? 'remove' : 'detach') : null,
    mainBackTo: direction === 'to-worktree' ? f.mainBackTo : null,
    switchMain: direction === 'to-main' && !alreadyThere,
    blockers,
  };
}

/** Probe the repo, then {@link decideMove}. Never throws. */
export async function planMove(
  task: MoveTaskInput & { repoPath: string },
  opts: { busy: boolean; worktreeRoot: string | null; home: string; mainBackTo?: string | null },
): Promise<MovePlan> {
  const [main, current, dirty] = await Promise.all([
    probeMainCheckout(task.repoPath),
    git(['symbolic-ref', '--quiet', '--short', 'HEAD'], task.worktreePath).then(
      (r) => (r.code === 0 ? r.stdout.trim() || null : null),
      () => null,
    ),
    uncommittedChanges(task.worktreePath).then((c) => c.files.length, () => null),
  ]);
  let newWorktreePath: string | null = null;
  let newPathTaken = false;
  if (opts.worktreeRoot && task.branch) {
    newWorktreePath = composeWorktreePath(opts.worktreeRoot, nameTask(task.branch).dirName, opts.home);
    const { exists } = await import('@tauri-apps/plugin-fs');
    newPathTaken = await exists(newWorktreePath).catch(() => false);
  }
  return decideMove({
    task,
    busy: opts.busy,
    currentBranch: current,
    dirtyHere: dirty,
    main,
    newWorktreePath,
    newPathTaken,
    mainBackTo: opts.mainBackTo ?? (task.baseBranch && task.baseBranch !== task.branch ? task.baseBranch : null),
  });
}

/** Where the task is afterwards: the patch for its row. */
export interface MoveResult {
  worktreePath: string;
  ownsWorktree: boolean;
  /** Set when carried changes could not be applied: they wait in this stash. */
  stashLeft: string | null;
}

/** Run a plan with no blockers. The session must already be stopped. */
export async function runMove(
  plan: MovePlan,
  repoPath: string,
  taskId: number,
): Promise<MoveResult> {
  if (plan.blockers.length > 0) throw new Error(plan.blockers.join('\n'));
  const undo: Array<{ what: string; run: () => Promise<void> }> = [];
  const fail = async (err: unknown): Promise<never> => {
    const stuck: string[] = [];
    for (const step of undo.reverse()) {
      try {
        await step.run();
      } catch {
        stuck.push(step.what);
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      stuck.length === 0
        ? `${msg}\n\nEverything was put back as it was.`
        : `${msg}\n\nCould not undo: ${stuck.join('; ')}.`,
    );
  };

  // 1. Carry uncommitted changes in a stash known by its id.
  let stash: string | null = null;
  if (plan.carry > 0) {
    try {
      stash = await stashPush(plan.from, `albedo-move-task-${taskId}-${Date.now()}`);
      const sha = stash;
      undo.push({ what: `re-apply stash ${sha} in ${plan.from}`, run: () => stashApply(plan.from, sha) });
    } catch (err) {
      return fail(err);
    }
  }

  try {
    if (plan.direction === 'to-main') {
      // 2. Free the branch where it is.
      if (plan.oldFolder === 'remove') {
        await removeWorktree({ repoPath, path: plan.from, branch: null, force: false, deleteBranch: false });
        undo.push({
          what: `recreate ${plan.from}`,
          run: () =>
            createWorktree({ repoPath, baseBranch: plan.branch, branch: plan.branch, path: plan.from, useExistingBranch: true }),
        });
      } else if (plan.switchMain) {
        await gitOk(['switch', '--detach'], plan.from);
        undo.push({
          what: `switch ${plan.from} back to ${plan.branch}`,
          run: async () => {
            await gitOk(['switch', plan.branch], plan.from);
          },
        });
      }
      // 3. Check it out in the main checkout, unless it is there already.
      if (plan.switchMain) await switchCleanCheckout({ path: plan.to, branch: plan.branch });
    } else {
      const back = plan.mainBackTo as string;
      // 2. Free the branch: the main checkout goes back.
      await switchCleanCheckout({ path: plan.from, branch: back });
      undo.push({ what: `switch ${plan.from} back to ${plan.branch}`, run: () => switchCleanCheckout({ path: plan.from, branch: plan.branch }) });
      // 3. Check it out in a new worktree.
      await createWorktree({ repoPath, baseBranch: plan.branch, branch: plan.branch, path: plan.to, useExistingBranch: true });
    }
  } catch (err) {
    return fail(err);
  }

  // 4. The changes land where the task now is. A failure here leaves them in
  // the stash rather than undoing a move that otherwise worked.
  let stashLeft: string | null = null;
  if (stash) {
    try {
      await stashApply(plan.to, stash);
      await stashDrop(plan.to, stash);
    } catch {
      stashLeft = stash;
    }
  }
  return { worktreePath: plan.to, ownsWorktree: plan.direction === 'to-worktree', stashLeft };
}

/** `git stash push -u`, returning the stash commit's id. */
async function stashPush(cwd: string, message: string): Promise<string> {
  await gitOk(['stash', 'push', '--include-untracked', '-m', message], cwd);
  const sha = await stashByMessage(cwd, message);
  if (!sha) {
    throw new GitError({ args: ['stash', 'list'], cwd, code: null, stdout: '', stderr: `The stash "${message}" was made but cannot be found.` });
  }
  return sha;
}

async function stashApply(cwd: string, sha: string): Promise<void> {
  await gitOk(['stash', 'apply', '--index', sha], cwd);
}

/** Drop by id: find its current position first, which other sessions may have moved. */
async function stashDrop(cwd: string, sha: string): Promise<void> {
  const list = await gitOk(['stash', 'list', '--format=%H %gd'], cwd);
  const ref = list
    .split('\n')
    .map((l) => l.trim().split(' '))
    .find(([h]) => h === sha)?.[1];
  if (ref) await gitOk(['stash', 'drop', ref], cwd);
}

async function stashByMessage(cwd: string, message: string): Promise<string | null> {
  const list = await gitOk(['stash', 'list', '--format=%H %gs'], cwd);
  for (const line of list.split('\n')) {
    const i = line.indexOf(' ');
    if (i > 0 && line.slice(i + 1).endsWith(message)) return line.slice(0, i);
  }
  return null;
}
