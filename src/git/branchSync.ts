/**
 * Keep a task's stored branch in step with what its worktree has checked out.
 *
 * `tasks.branch` is written once, when the task is created. A task running in
 * the main checkout outlives that: the owner switches branches under it, and
 * every reader of the stored value goes quietly wrong -- the row and the files
 * pane name the old branch, and the PR lookup, seeing `branch === baseBranch`,
 * decides there is nothing to look up. Found with a task recorded on `main`
 * while its checkout sat on `build-script`, with PR #7 open and no badge.
 *
 * Git is the authority; the column is a cache of it. A detached HEAD or a
 * failed read changes nothing: there is no branch to record, and the last
 * known one is a better answer than none.
 */

import { useEffect, useRef } from 'react';
import type { Task } from '../types';
import { updateTask } from '../db';
import { git } from './worktree';

type SyncTask = Pick<Task, 'id' | 'branch' | 'worktreePath' | 'status' | 'createdBranch'> &
  Partial<Pick<Task, 'repoPath'>>;

/** Same cadence as the PR poll, which is what reads the result. */
const POLL_MS = 60_000;

/**
 * What to write, given the branch git reports. Null when nothing changes.
 *
 * `createdBranch` drops to false on a switch: it is what lets archive offer to
 * delete the branch, and Albedo did not create the one now checked out.
 * Switching back to Albedo's own branch leaves it false -- the branch is then
 * kept on archive, which is the safe way to be wrong.
 */
export function branchPatch(task: SyncTask, current: string | null): Partial<Task> | null {
  const b = current?.trim() ?? '';
  if (b.length === 0 || b === task.branch) return null;
  return { branch: b, createdBranch: task.createdBranch === true ? false : task.createdBranch };
}

/** The checked-out branch, or null on a detached HEAD or any failure. */
export async function checkedOutBranch(worktreePath: string): Promise<string | null> {
  try {
    const r = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktreePath);
    return r.code === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null; // worktree gone, git missing: keep what is stored
  }
}

function samePath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * What each of a repo's worktrees has checked out (#365): path -> branch, or
 * null for a detached HEAD, named exactly as `symbolic-ref --short HEAD`
 * names it in that folder. Two git calls for the whole repo:
 *
 *  - `worktree list --porcelain` gives each folder's full ref;
 *  - `for-each-ref` shortens them by the same rule as `symbolic-ref --short`
 *    (`core.warnAmbiguousRefs=false` makes it the non-strict rule
 *    symbolic-ref uses), so a branch that shares its name with a tag is
 *    `heads/x` here too.
 *
 * A folder git can no longer see (`prunable`), and a branch with no commit
 * yet (for-each-ref does not list it), are left out: their tasks ask on
 * their own, as before. Null when git cannot list them.
 */
export async function checkedOutBranches(repoPath: string): Promise<Map<string, string | null> | null> {
  try {
    const listed = await git(['worktree', 'list', '--porcelain'], repoPath);
    if (listed.code !== 0) return null;
    const heads = new Map<string, string | null>();
    for (const record of listed.stdout.split(/\r?\n\r?\n/)) {
      const lines = record.split(/\r?\n/).filter((l) => l.length > 0);
      const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
      if (!path || lines.some((l) => l === 'bare' || l === 'prunable' || l.startsWith('prunable '))) continue;
      const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);
      if (ref) heads.set(samePath(path), ref);
      else if (lines.includes('detached')) heads.set(samePath(path), null);
    }
    const refs = [...new Set([...heads.values()].filter((r): r is string => r !== null))];
    const short = new Map<string, string>();
    if (refs.length > 0) {
      const named = await git(
        ['-c', 'core.warnAmbiguousRefs=false', 'for-each-ref', '--format=%(refname)%00%(refname:short)', '--', ...refs],
        repoPath,
      );
      if (named.code !== 0) return null;
      for (const line of named.stdout.split('\n')) {
        const nul = line.indexOf('\0');
        if (nul > 0) short.set(line.slice(0, nul), line.slice(nul + 1).replace(/\r$/, ''));
      }
    }
    const out = new Map<string, string | null>();
    for (const [path, ref] of heads) {
      if (ref === null) out.set(path, null);
      else if (short.has(ref)) out.set(path, short.get(ref)!);
    }
    return out;
  } catch {
    return null;
  }
}

const inflight = new Set<number>();

/**
 * `known` is {@link checkedOutBranches} for the task's repo, when the sweep
 * has it. A folder it does not list (another path spelling, another repo) is
 * asked on its own, exactly as without it.
 */
export async function syncTaskBranch(task: SyncTask, known?: ReadonlyMap<string, string | null> | null): Promise<void> {
  if (task.status === 'archived' || !task.worktreePath || inflight.has(task.id)) return;
  inflight.add(task.id);
  try {
    const path = samePath(task.worktreePath);
    const current = known?.has(path) ? (known.get(path) ?? null) : await checkedOutBranch(task.worktreePath);
    const patch = branchPatch(task, current);
    if (patch) await updateTask(task.id, patch);
  } catch (err) {
    console.warn('[git] branch sync failed', err);
  } finally {
    inflight.delete(task.id);
  }
}

/**
 * Sync every task once: one `git worktree list` per repo (#365), not one git
 * per task. Tasks with no repo, or in a folder that list does not name, ask
 * on their own.
 */
export async function syncBranches(tasks: readonly SyncTask[]): Promise<void> {
  const byRepo = new Map<string, SyncTask[]>();
  const alone: SyncTask[] = [];
  for (const t of tasks) {
    if (t.status === 'archived' || !t.worktreePath || inflight.has(t.id)) continue;
    if (!t.repoPath) alone.push(t);
    else byRepo.set(t.repoPath, [...(byRepo.get(t.repoPath) ?? []), t]);
  }
  await Promise.all([
    ...alone.map((t) => syncTaskBranch(t)),
    ...[...byRepo].map(async ([repo, list]) => {
      const known = await checkedOutBranches(repo);
      await Promise.all(list.map((t) => syncTaskBranch(t, known)));
    }),
  ]);
}

/** Sync the given tasks now, every {@link POLL_MS}, and on window focus. */
export function useBranchSync(tasks: SyncTask[]): void {
  const ref = useRef(tasks);
  ref.current = tasks;
  const key = tasks
    .filter((t) => t.status !== 'archived')
    .map((t) => t.id)
    .join(',');

  useEffect(() => {
    const sweep = () => {
      void syncBranches(ref.current);
    };
    sweep();
    const timer = setInterval(() => {
      if (!document.hidden) sweep();
    }, POLL_MS);
    window.addEventListener('focus', sweep);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', sweep);
    };
  }, [key]);
}
