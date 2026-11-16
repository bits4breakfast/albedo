/**
 * Keeping a review copy current (#352): the PR moved on after it was checked
 * out, and the copy follows it only when you ask (Update Copy).
 *
 * The copy is the worktree on `review/<n>` (reviewCheckout.ts). git will not
 * fetch into a branch that is checked out, so the PR's head is fetched to
 * FETCH_HEAD -- with the base's tracking ref refreshed in the same call, as
 * the first checkout does -- and the worktree is moved to it there:
 *
 *   fast-forward   `git merge --ff-only`, when the old head is in the new one;
 *   force-push     `git reset --keep`, which keeps local edits to files the
 *                  move does not touch and refuses, leaving HEAD where it
 *                  was, when it would have to overwrite one.
 *
 * Either way a failure throws GitError with git's own words, and nothing is
 * discarded: `--keep` is the reset that refuses rather than loses.
 *
 * The rest reads what changed between two heads, for "Since your review":
 * the commits, the files with their counts, and the material for the short
 * explanation (the commit messages and the diff between them, nothing else).
 */

import { git, gitOk, GitError, parseNumstat, taskBase } from './worktree';
import { baseRefspec, prRemote, type PrRef } from './reviewCheckout';

/** What Update Copy did. `moved` false: the copy was already at the PR's head. */
export interface UpdateResult {
  prev: string;
  next: string;
  /** The old head is not in the new one: moved with `reset --keep`. */
  forced: boolean;
  moved: boolean;
  /**
   * After a forced move, the branch the old copy was kept on
   * (`review/<n>-previous`): a commit made in the copy is not in the PR's new
   * head, and moving past it must not lose it. Null otherwise.
   */
  kept: string | null;
}

/** Where a forced update keeps the copy it moved away from. */
export function keptBranch(n: number): string {
  return `review/${n}-previous`;
}

/** Whether `a` is an ancestor of (or equal to) `b`. */
export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  const r = await git(['merge-base', '--is-ancestor', a, b], cwd);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new GitError({ args: ['merge-base', '--is-ancestor', a, b], cwd, code: r.code, stdout: r.stdout, stderr: r.stderr });
}

/**
 * Fetch the PR's head and move the copy in `worktreePath` to it. `onPrev`
 * hears the head the copy was on before anything moves. Throws GitError.
 */
export async function updateReviewCopy(
  worktreePath: string,
  pr: PrRef,
  baseBranch: string,
  onPrev?: (prev: string) => void,
): Promise<UpdateResult> {
  const remote = await prRemote(worktreePath, pr);
  const refspecs = [`+refs/pull/${pr.number}/head`];
  const base = baseRefspec(remote, baseBranch);
  if (base) refspecs.push(base);
  // The PR's head is FETCH_HEAD's first line: the first refspec given.
  await gitOk(['fetch', '--no-tags', remote, ...refspecs], worktreePath);
  const next = (await gitOk(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], worktreePath)).trim();
  const prev = (await gitOk(['rev-parse', '--verify', 'HEAD'], worktreePath)).trim();
  onPrev?.(prev);
  if (prev === next) return { prev, next, forced: false, moved: false, kept: null };
  const forced = !(await isAncestor(worktreePath, prev, next));
  // A file touched and put back is still "not uptodate" to a stale index, and
  // both moves would refuse over it. Refreshing the index's stat data changes
  // no file and no content.
  await git(['update-index', '-q', '--refresh'], worktreePath);
  // The sha just read, not FETCH_HEAD: another fetch in the same worktree
  // cannot change what this one moves to.
  // A forced move leaves the old head on no branch. It may hold commits made
  // in the copy (a fix tried during review), so it is kept on a branch first;
  // nothing is discarded silently. One per PR: the copy before the last forced update.
  const kept = forced ? keptBranch(pr.number) : null;
  if (kept) await gitOk(['branch', '-f', kept, prev], worktreePath);
  await gitOk(forced ? ['reset', '--keep', next] : ['merge', '--ff-only', next], worktreePath);
  return { prev, next, forced, moved: true, kept };
}

/** The copy as it stands: its head, and its commits ahead of the base (null when the base is not found). */
export interface CopyState {
  head: string;
  localCommits: number | null;
}

export async function readCopy(worktreePath: string, baseBranch: string): Promise<CopyState> {
  const head = (await gitOk(['rev-parse', '--verify', 'HEAD'], worktreePath)).trim();
  const base = await taskBase(worktreePath, baseBranch).catch(() => null);
  let localCommits: number | null = null;
  if (base) {
    const r = await git(['rev-list', '--count', `${base}..HEAD`], worktreePath);
    const n = Number(r.stdout.trim());
    if (r.code === 0 && Number.isInteger(n)) localCommits = n;
  }
  return { head, localCommits };
}

// ---------------------------------------------------------------------------
// What changed between two heads
// ---------------------------------------------------------------------------

export interface SinceCommit {
  sha: string;
  /** Commit time, ms. */
  at: number;
  subject: string;
}

export interface SinceFile {
  path: string;
  /** Null for a binary file. */
  added: number | null;
  deleted: number | null;
}

export interface SinceChanges {
  commits: SinceCommit[];
  files: SinceFile[];
  /** `prev` is not in `next`: the PR was force-pushed between them. */
  forced: boolean;
}

/** `git log --format=%x1e%H%x1f%ct%x1f%s` output, newest first. Pure. */
export function parseSinceLog(stdout: string): SinceCommit[] {
  const out: SinceCommit[] = [];
  for (const rec of stdout.split('\u001e')) {
    const [sha, ct, ...rest] = rec.replace(/\n+$/, '').split('\u001f');
    const at = Number(ct) * 1000;
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha.trim()) || !Number.isFinite(at)) continue;
    out.push({ sha: sha.trim(), at, subject: rest.join('\u001f') });
  }
  return out;
}

/**
 * The commits in `next` that are not in `prev` -- `prev..next`, which after a
 * force-push is exactly "the commits the new head has that yours did not" --
 * and the files that differ between the two, with their counts. Throws
 * GitError (for one, when `prev` is no longer in the repository).
 */
export async function sinceChanges(worktreePath: string, prev: string, next: string): Promise<SinceChanges> {
  const forced = !(await isAncestor(worktreePath, prev, next));
  const log = await gitOk(['log', '--no-color', '--format=%x1e%H%x1f%ct%x1f%s', `${prev}..${next}`], worktreePath);
  const stat = await gitOk(['-c', 'core.quotePath=false', 'diff', '--numstat', '--no-renames', prev, next], worktreePath);
  const files = [...parseNumstat(stat)].map(([path, c]) => ({ path, added: c.added, deleted: c.deleted }));
  return { commits: parseSinceLog(log), files, forced };
}

/** One commit as the explanation reads it: its whole message. */
export interface ExplainCommit {
  sha: string;
  subject: string;
  body: string;
}

/** `git log --format=%x1e%H%x1f%s%x1f%b` output. Pure. */
export function parseMessageLog(stdout: string): ExplainCommit[] {
  const out: ExplainCommit[] = [];
  for (const rec of stdout.split('\u001e')) {
    const [sha, subject, ...rest] = rec.split('\u001f');
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha.trim())) continue;
    out.push({ sha: sha.trim(), subject: (subject ?? '').trim(), body: rest.join('\u001f').trim() });
  }
  return out;
}

/** What the explanation is written from: the messages of `prev..next` and the diff between the two. */
export async function explainMaterial(
  worktreePath: string,
  prev: string,
  next: string,
): Promise<{ commits: ExplainCommit[]; diff: string }> {
  const log = await gitOk(['log', '--no-color', '--format=%x1e%H%x1f%s%x1f%b', `${prev}..${next}`], worktreePath);
  const diff = await gitOk(
    ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '-U2', prev, next],
    worktreePath,
  );
  return { commits: parseMessageLog(log), diff };
}
