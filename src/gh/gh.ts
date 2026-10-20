/**
 * The GitHub CLI runner. Modelled on `git()` / `gitOk()` in git/worktree.ts,
 * and the same rules apply: argv, never a shell string; parsing lives
 * elsewhere (`prStatus.ts`) so it can be tested without spawning anything; the
 * shell plugin is imported lazily so vitest never loads the IPC bridge.
 *
 * One difference, on purpose: **this module never throws at its callers.**
 * PR status is an ornament on a task, not something the task depends on.
 * gh missing, gh logged out, offline, no PR for the branch -- every one of
 * those ends as `null`, and the badge simply is not drawn. An error banner for
 * "this branch has no PR yet" would be noise on every new task.
 */

import type { Task } from '../types';
import { parsePrView, type PrStatus } from './prStatus';

export interface GhResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The shell-scope names `gh` may be spawned under, in the order tried. See
 * src-tauri/capabilities/default.json.
 *
 * `gh` alone resolves through this process's PATH, which is right under
 * `tauri dev` (started from a terminal) and wrong for a .app launched from
 * Finder, whose PATH is roughly `/usr/bin:/bin` -- gh is never there. pty.rs
 * solves the same problem for `claude` with a login shell; for a read-only
 * status probe two fixed Homebrew locations are the smaller hammer, and the
 * scope stays an exact binary rather than "anything a shell can run".
 *
 * `gh-usr-bin` is Linux: the apt and dnf packages install `/usr/bin/gh`. A
 * desktop launcher's PATH normally has `/usr/bin` already, so it is a
 * backstop, tried last; on macOS it is one more failed spawn, once.
 */
export const GH_PROGRAMS = ['gh', 'gh-homebrew', 'gh-usr-local', 'gh-usr-bin'] as const;
export type GhProgram = (typeof GH_PROGRAMS)[number];

/** Swappable runner. Throws only when the program could not be spawned. */
export type GhRunner = (program: GhProgram, args: string[], cwd?: string) => Promise<GhResult>;

let runner: GhRunner = async (program, args, cwd) => {
  const { Command } = await import('@tauri-apps/plugin-shell');
  // GH_PROMPT_DISABLED: never wait on a question nobody can see. NO_COLOR and
  // GH_PAGER: the output is JSON for a parser, not a terminal.
  const env = { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_PAGER: 'cat' };
  const child = await Command.create(program, args, cwd ? { cwd, env } : { env }).execute();
  return { code: child.code, stdout: child.stdout, stderr: child.stderr };
};

/** Test seam. Returns the previous runner so a test can restore it. */
export function setGhRunner(next: GhRunner): GhRunner {
  const prev = runner;
  runner = next;
  resolved = null;
  return prev;
}

/**
 * Which program spawned last time. Remembered so the Finder case costs two
 * failed spawns once per launch, not per task per minute.
 */
let resolved: GhProgram | null = null;

/** Same guard as git's: argv only, strings only, no NUL. */
export function assertSafeArgv(args: string[]): void {
  for (const a of args) {
    if (typeof a !== 'string') throw new Error('gh argv must be strings');
    if (a.includes('\0')) throw new Error('gh argv must not contain NUL');
  }
}

/**
 * Run gh and return the raw result, or null when no gh could be spawned at
 * all. A non-zero exit is a result, not a null: the caller decides.
 */
export async function gh(args: string[], cwd?: string): Promise<GhResult | null> {
  assertSafeArgv(args);
  const order = resolved ? [resolved] : GH_PROGRAMS;
  for (const program of order) {
    try {
      const r = await runner(program, args, cwd);
      resolved = program;
      return r;
    } catch {
      // Not on this path (or the cwd is gone). Try the next location.
    }
  }
  // If the remembered one stopped working (gh uninstalled, moved), forget it
  // so the next call searches again.
  resolved = null;
  return null;
}

const PR_FIELDS =
  'number,url,state,isDraft,title,reviewDecision,statusCheckRollup,mergedAt,headRefName';

/**
 * Is there a PR for this task worth asking about? A resumed session often
 * runs on the repo's base branch, and `gh pr view main` can find some stray PR
 * opened FROM main -- attributing that to the task would be wrong.
 */
export function prLookupBranch(task: Pick<Task, 'branch' | 'baseBranch'>): string | null {
  const b = task.branch.trim();
  if (!b || b === 'HEAD' || b === task.baseBranch) return null;
  // A ref starting with "-" would read as a flag; slug.ts never makes one.
  if (b.startsWith('-')) return null;
  return b;
}

/**
 * The PR for a task's branch, or null for "no PR / cannot tell". Runs in the
 * worktree as asked, and falls back to the origin repo when the worktree is
 * gone (removed on archive) -- the branch lookup only needs the remote, which
 * both share.
 */
export async function fetchPrStatus(
  task: Pick<Task, 'branch' | 'baseBranch' | 'worktreePath' | 'repoPath'>,
): Promise<PrStatus | null> {
  const branch = prLookupBranch(task);
  if (!branch) return null;
  const args = ['pr', 'view', branch, '--json', PR_FIELDS];
  for (const cwd of [task.worktreePath, task.repoPath]) {
    if (!cwd) continue;
    const r = await gh(args, cwd);
    if (!r) continue; // could not spawn here: the cwd may not exist
    // Exit 1 covers "no pull requests found", "not logged in", "no remote",
    // offline. None of them is something to shout about; all mean "no badge".
    if (r.code !== 0) return null;
    const pr = parsePrView(r.stdout);
    // gh resolves a bare branch name loosely; be sure it is ours.
    if (pr && pr.headRefName && pr.headRefName !== branch) return null;
    return pr;
  }
  return null;
}

/** What a branch's pull request says about it, for checking the branch out. */
export interface PrBase {
  number: number;
  title: string;
  /** The branch the PR merges into. */
  base: string;
}

/**
 * The pull request whose head is `branch`, read for its base: the base of a
 * colleague's branch is a fact GitHub holds, not something to guess. Null for
 * no PR or no answer, like everything here.
 */
export async function fetchPrBase(branch: string, repoPath: string): Promise<PrBase | null> {
  const b = branch.trim();
  if (!b || b.startsWith('-')) return null;
  const r = await gh(['pr', 'view', b, '--json', 'number,title,baseRefName,headRefName'], repoPath);
  if (!r || r.code !== 0) return null;
  return parsePrBase(r.stdout, b);
}

/** Pure half of {@link fetchPrBase}. gh resolves a bare name loosely, so the head must match. */
export function parsePrBase(stdout: string, branch: string): PrBase | null {
  let d: unknown;
  try {
    d = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (typeof o.number !== 'number' || typeof o.baseRefName !== 'string' || !o.baseRefName) return null;
  if (typeof o.headRefName === 'string' && o.headRefName !== branch) return null;
  return { number: o.number, title: typeof o.title === 'string' ? o.title : '', base: o.baseRefName };
}
