/**
 * Checking out someone else's pull request for review (#287).
 *
 * The PR's head is fetched from `refs/pull/<n>/head` -- GitHub keeps that ref
 * on the base repository for every PR, forks included -- straight into a
 * local branch `review/<n>`, and a worktree is added on it. The branch is
 * Albedo's own name for the copy: it never takes the author's branch name
 * (which could clash with one of yours) and has no upstream, so a `git push`
 * from the worktree has nowhere to go.
 *
 * The PR's base is fetched in the same call, so what the review is measured
 * against is as fresh as the head.
 */

import { git, GitError } from './worktree';

export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

/** `https://github.com/<owner>/<repo>/pull/<n>`, or null for anything else. */
export function parsePrUrl(url: string): PrRef | null {
  const m = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/.exec(url.trim());
  if (!m) return null;
  const number = Number(m[4]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { host: m[1]!.toLowerCase(), owner: m[2]!, repo: m[3]!, number };
}

/** The local branch a review of PR `n` is on. */
export function reviewBranch(n: number): string {
  return `review/${n}`;
}

/** Host and `owner/repo` of a remote URL, in any of git's spellings; null if not one. */
export function remoteRepo(url: string): { host: string; path: string } | null {
  const u = url.trim();
  // scp-like: git@github.com:owner/repo(.git)
  let m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)([^\s]+?)(?:\.git)?\/?$/.exec(u);
  // ssh://, https://, git://
  m ??= /^[a-z+]+:\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/([^\s]+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  return { host: m[1]!.toLowerCase(), path: m[2]!.toLowerCase() };
}

/**
 * The remote that is the PR's repository, from `git remote -v`: the one whose
 * fetch URL ends in its `owner/repo`. The host is not compared: an SSH alias
 * (`github-work:acme/relay`) or an `insteadOf` rewrite names the same
 * repository under another host. With no match, `origin`, if there is one:
 * fetching `refs/pull/<n>/head` from the wrong repository only fails, with
 * git saying so.
 */
export function remoteForPr(remoteVerbose: string, pr: PrRef): string | null {
  const want = `${pr.owner}/${pr.repo}`.toLowerCase();
  let origin = false;
  for (const line of remoteVerbose.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'origin') origin = true;
    const r = remoteRepo(m[2]!);
    if (r && (r.path === want || r.path.endsWith(`/${want}`))) return m[1]!;
  }
  return origin ? 'origin' : null;
}

/**
 * Fetch the PR's head into `review/<n>` (forced: the branch is Albedo's copy
 * and holds nothing of yours) and its base into the remote's tracking ref.
 * Returns the branch. Throws GitError with git's own words.
 */
export async function fetchReviewHead(repoPath: string, pr: PrRef, baseBranch: string): Promise<string> {
  const remotes = await git(['remote', '-v'], repoPath);
  const remote = remotes.code === 0 ? remoteForPr(remotes.stdout, pr) : null;
  if (!remote) {
    throw new GitError({
      args: ['remote', '-v'],
      cwd: repoPath,
      code: remotes.code,
      stdout: '',
      stderr: `No remote of this repository is ${pr.owner}/${pr.repo}, where the pull request is, and there is no origin.`,
    });
  }
  const branch = reviewBranch(pr.number);
  const refspecs = [`+refs/pull/${pr.number}/head:refs/heads/${branch}`];
  if (baseBranch && !baseBranch.startsWith('-')) {
    refspecs.push(`+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`);
  }
  const args = ['fetch', '--no-tags', remote, ...refspecs];
  const r = await git(args, repoPath);
  if (r.code !== 0) throw new GitError({ args, cwd: repoPath, code: r.code, stdout: r.stdout, stderr: r.stderr });
  return branch;
}
