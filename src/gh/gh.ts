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
import { withoutAnthropicKeys } from '../lib/spawnEnv';
import { parsePrGraphql, PR_QUERY, type PrStatus } from './prStatus';
import {
  parseAnnotations,
  parsePrChecks,
  parseRunJob,
  type Annotation,
  type CheckSource,
  type JobDetail,
  type PrCheck,
} from './checks';

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
  // GH_PAGER: the output is JSON for a parser, not a terminal. The Anthropic
  // credentials are blanked: gh runs extensions (hard rule 3).
  const env = withoutAnthropicKeys({ GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_PAGER: 'cat' });
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

/**
 * The signed-in gh user's login, asked once per run (#180): the review chip
 * hides "Awaiting Review" on the owner's own PRs nobody was asked to review.
 * Null is "not known" -- no gh, not logged in, offline -- and hides nothing.
 * A login is kept for the run; a failure is asked again, at most every
 * {@link VIEWER_RETRY_MS}, so a launch while offline is not stuck with it.
 */
export const VIEWER_RETRY_MS = 5 * 60_000;
let viewer: string | null = null;
let viewerAsked: Promise<string | null> | null = null;
let viewerFailedAt = -Infinity;

/** The login, once known; null before that or when it cannot be known. */
export function viewerLogin(): string | null {
  return viewer;
}

/** Ask gh for the login, unless it is known or was just asked. */
export function loadViewerLogin(): Promise<string | null> {
  if (viewer !== null) return Promise.resolve(viewer);
  if (viewerAsked) return viewerAsked;
  if (Date.now() - viewerFailedAt < VIEWER_RETRY_MS) return Promise.resolve(null);
  viewerAsked = gh(['api', 'user', '--jq', '.login'])
    .then((r) => {
      const login = r && r.code === 0 ? r.stdout.trim() : '';
      // A login has no spaces or slashes; anything else is not one. An
      // Enterprise managed user's has an underscore (`alice_acme`).
      if (login && /^[A-Za-z0-9_-]+(\[bot\])?$/.test(login)) viewer = login;
      else viewerFailedAt = Date.now();
      return viewer;
    })
    .catch(() => {
      viewerFailedAt = Date.now();
      return null;
    })
    .finally(() => {
      viewerAsked = null;
    });
  return viewerAsked;
}

/** @internal for tests */
export function resetViewerLoginForTests(login: string | null = null): void {
  viewer = login;
  viewerAsked = null;
  viewerFailedAt = -Infinity;
}

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
 *
 * One `gh api graphql` request (#278): what `gh pr view <branch> --json …`
 * asked before, plus the review threads, in the same single call, so the
 * unresolved count adds nothing to the PR store's rate (prStore.ts).
 * `{owner}` and `{repo}` are gh's own placeholders, filled from the folder's
 * remote as `gh pr view` resolves it; they work only through -F. The branch
 * goes through -f, raw: -F would turn a branch named `193` into a number.
 * The Accept header is the preview `gh pr view` sends for mergeStateStatus.
 */
export async function fetchPrStatus(
  task: Pick<Task, 'branch' | 'baseBranch' | 'worktreePath' | 'repoPath'>,
): Promise<PrStatus | null> {
  const answer = await fetchPrAnswer(task);
  return answer === PR_FETCH_FAILED ? null : answer;
}

/** {@link fetchPrAnswer}'s "gh could not answer": not the same as "no PR". */
export const PR_FETCH_FAILED = 'failed' as const;

/**
 * {@link fetchPrStatus}, telling "gh could not answer" ({@link
 * PR_FETCH_FAILED}: not logged in, no remote, offline, rate-limited, a
 * GraphQL or server error, output that is not GitHub's answer, nowhere to run
 * gh) from GitHub's answer -- a PR, or null for none (#365 review). The PR
 * store keeps its last answer on a failure instead of reading it as "none".
 */
export async function fetchPrAnswer(
  task: Pick<Task, 'branch' | 'baseBranch' | 'worktreePath' | 'repoPath'>,
): Promise<PrStatus | null | typeof PR_FETCH_FAILED> {
  const branch = prLookupBranch(task);
  if (!branch) return null;
  const args = [
    'api',
    'graphql',
    '-H',
    'Accept: application/vnd.github.merge-info-preview+json',
    '-F',
    'owner={owner}',
    '-F',
    'repo={repo}',
    '-f',
    `branch=${branch}`,
    '-f',
    `query=${PR_QUERY}`,
  ];
  for (const cwd of [task.worktreePath, task.repoPath]) {
    if (!cwd) continue;
    const r = await gh(args, cwd);
    if (!r) continue; // could not spawn here: the cwd may not exist
    // Non-zero covers "not logged in", "no remote", offline and a GraphQL
    // error. None of them is something to shout about; none is "no PR".
    if (r.code !== 0) return PR_FETCH_FAILED;
    if (!answeredRepository(r.stdout)) return PR_FETCH_FAILED;
    // Only a PR whose head is this branch: parsePrGraphql checks.
    return parsePrGraphql(r.stdout, branch);
  }
  return PR_FETCH_FAILED;
}

/** Whether `stdout` is GraphQL's answer about the repository at all. */
function answeredRepository(stdout: string): boolean {
  try {
    const data = (JSON.parse(stdout) as { data?: { repository?: unknown } } | null)?.data;
    return typeof data?.repository === 'object' && data.repository !== null;
  } catch {
    return false;
  }
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

// ---------------------------------------------------------------------------
// Checks in detail (checks.ts), fetched only while the Checks dialog is open
// ---------------------------------------------------------------------------

const CHECK_FIELDS = 'bucket,completedAt,description,link,name,startedAt,workflow';

/**
 * A PR's checks, one per check after reruns. gh documents exit 8 for
 * "pending"; measured on gh 2.97, `--json` with checks pending printed the
 * list and exited 0. Either way stdout is read whatever the exit code, and
 * only output that is not a list means "no answer".
 */
export async function fetchPrChecks(
  prNumber: number,
  task: Pick<Task, 'worktreePath' | 'repoPath'>,
): Promise<PrCheck[] | null> {
  const args = ['pr', 'checks', String(prNumber), '--json', CHECK_FIELDS];
  for (const cwd of [task.worktreePath, task.repoPath]) {
    if (!cwd) continue;
    const r = await gh(args, cwd);
    if (!r) continue; // could not spawn here: the cwd may not exist
    return parsePrChecks(r.stdout);
  }
  return null;
}

type JobRef = Extract<CheckSource, { kind: 'actions' }>;

/** `-R` names the repository, so these run anywhere: the check's link says which. */
function repoFlag(ref: { host: string; repo: string }): string {
  return ref.host === 'github.com' ? ref.repo : `${ref.host}/${ref.repo}`;
}

function hostArgs(ref: { host: string }): string[] {
  return ref.host === 'github.com' ? [] : ['--hostname', ref.host];
}

/** One Actions job's steps. Null for no answer. */
export async function fetchJob(ref: JobRef): Promise<JobDetail | null> {
  const r = await gh(['run', 'view', ref.runId, '-R', repoFlag(ref), '--json', 'jobs']);
  if (!r || r.code !== 0) return null;
  return parseRunJob(r.stdout, ref.jobId);
}

/**
 * One job's raw log, from the per-job endpoint (see checks.ts for why not
 * `--log-failed`). gh 2.97 refuses to print a response that holds terminal
 * escapes -- a log always does -- unless told it may; checks.ts strips them.
 * A gh older than that flag is asked again without it.
 */
export async function fetchJobLog(ref: JobRef): Promise<string | null> {
  const path = `repos/${ref.repo}/actions/jobs/${ref.jobId}/logs`;
  let r = await gh(['api', '--allow-escape-sequences', ...hostArgs(ref), path]);
  if (r && r.code !== 0 && /unknown flag/i.test(r.stderr)) r = await gh(['api', ...hostArgs(ref), path]);
  if (!r || r.code !== 0) return null;
  return r.stdout;
}

/** A check run's annotations: an Actions job is a check run with the job's id. */
export async function fetchAnnotations(ref: { host: string; repo: string; id: string }): Promise<Annotation[]> {
  const r = await gh(['api', ...hostArgs(ref), `repos/${ref.repo}/check-runs/${ref.id}/annotations`]);
  if (!r || r.code !== 0) return [];
  return parseAnnotations(r.stdout);
}

// ---------------------------------------------------------------------------
// Squash and merge (#236): the one GitHub write Albedo makes itself
// ---------------------------------------------------------------------------

export type MergeOutcome =
  | { ok: true; branchNotDeleted?: string }
  | { ok: false; message: string };

/**
 * `gh pr merge <n> --squash`, by the owner's decision (#236), and only from
 * the confirm dialog. Never `--admin`: when GitHub refuses, its message is the
 * answer, shown in the dialog. Unlike the reads above, a failure is reported,
 * not folded into null -- the person who pressed the button needs to know.
 *
 * Deleting the branch is GitHub's half only: the remote ref, through the API,
 * after the merge. Not gh's `--delete-branch`, which also deletes the local
 * branch and switches the checkout off it -- in a task's worktree that branch
 * is checked out, so gh would fail half-way or move the worktree. The worktree
 * and its branch stay as they are; Archive… is where they go.
 *
 * Runs where the PR lookup does: the worktree, else the main checkout (the
 * worktree may be gone). gh finds the repository from the folder's remote.
 */
export async function mergePr(
  pr: { number: number; headRefName: string; headSha?: string },
  task: Pick<Task, 'worktreePath' | 'repoPath'>,
  opts: { deleteBranch: boolean },
): Promise<MergeOutcome> {
  if (!Number.isInteger(pr.number) || pr.number <= 0) return { ok: false, message: 'Not a pull request number.' };
  for (const cwd of [task.worktreePath, task.repoPath]) {
    if (!cwd) continue;
    // Only the head that was approved and shown: a push that lands while the
    // dialog is open makes GitHub refuse, rather than merge unseen commits.
    const head = pr.headSha && /^[0-9a-f]{7,64}$/i.test(pr.headSha) ? ['--match-head-commit', pr.headSha] : [];
    const r = await gh(['pr', 'merge', String(pr.number), '--squash', ...head], cwd);
    if (!r) continue; // could not spawn here: the cwd may not exist
    if (r.code !== 0) return { ok: false, message: ghMessage(r) };
    if (!opts.deleteBranch || !pr.headRefName) return { ok: true };
    const ref = pr.headRefName.split('/').map(encodeURIComponent).join('/');
    const d = await gh(['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${ref}`], cwd);
    // Already gone (the repo deletes merged branches itself) is what was asked.
    // Only "already gone" -- not any 422, which is also how GitHub refuses a
    // protected branch.
    if (!d || (d.code !== 0 && !/Reference does not exist/i.test(d.stderr + d.stdout))) {
      return { ok: true, branchNotDeleted: d ? ghMessage(d) : 'GitHub CLI (gh) could not be run.' };
    }
    return { ok: true };
  }
  return { ok: false, message: 'GitHub CLI (gh) could not be run.' };
}

/** gh's own words for a failure, without colour codes; the exit code when it said nothing. */
export function ghMessage(r: GhResult): string {
  // eslint-disable-next-line no-control-regex
  const text = (r.stderr || r.stdout).replace(/\x1b\[[0-9;]*m/g, '').trim();
  return text || `gh exited with ${r.code ?? 'a signal'}.`;
}
