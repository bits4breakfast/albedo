/**
 * Git worktree service (M3).
 *
 * Design rules, in priority order:
 *
 * 1. **argv, never a shell string.** Every git invocation goes through
 *    {@link git}, which takes `string[]`. Nothing in this file concatenates a
 *    branch name or a path into a command line, so a repo called
 *    `my repo; rm -rf ~` is inert by construction.
 * 2. **No silent failures.** Every invocation checks the exit code and throws a
 *    {@link GitError} carrying argv, cwd, exit code and git's own stderr.
 * 3. **Parsing is separated from spawning.** The `parse*` functions below are
 *    pure and exported so they can be unit-tested; only the thin `git()` helper
 *    touches Tauri. The shell plugin is imported lazily for the same reason --
 *    importing this module under vitest must not drag in the IPC bridge.
 * 4. **We never delete a directory ourselves.** `git worktree remove` does it,
 *    then `git worktree prune`. There is no `rm -rf` anywhere in this module.
 */

import type { Project } from '../types';
import { assertValidRefName, isValidRefName } from './slug';
import { expandTilde, normalizePath } from './reconcile';

// ---------------------------------------------------------------------------
// Frozen contract (docs/INTERFACES.md)
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why a git command failed, classified from stderr. The UI branches on this;
 * `unknown` means "show git's stderr verbatim and stop".
 */
export type GitFailureKind =
  | 'not-a-repo'
  | 'branch-exists'
  | 'branch-checked-out'
  | 'base-missing'
  | 'path-exists'
  | 'path-in-use'
  | 'branch-not-merged'
  | 'main-worktree'
  | 'dirty'
  | 'not-found'
  | 'unknown';

export class GitError extends Error {
  readonly args: string[];
  readonly cwd: string | undefined;
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly kind: GitFailureKind;

  constructor(o: {
    args: string[];
    cwd?: string;
    code: number | null;
    stderr: string;
    stdout: string;
    kind?: GitFailureKind;
  }) {
    const kind = o.kind ?? classifyGitError(o.stderr);
    // The message deliberately leads with git's own words: the dialog shows
    // `err.message` and the user needs to see what git actually said.
    super(
      `${(o.stderr || o.stdout || `git exited with ${o.code}`).trim()}\n` +
        `  (git ${o.args.join(' ')}${o.cwd ? ` in ${o.cwd}` : ''})`,
    );
    this.name = 'GitError';
    this.args = o.args;
    this.cwd = o.cwd;
    this.code = o.code;
    this.stderr = o.stderr;
    this.stdout = o.stdout;
    this.kind = kind;
  }
}

/**
 * Pure stderr classifier. Order matters: the more specific patterns first.
 * Exported for tests -- git's wording is the only thing we have to go on, so it
 * is worth pinning down with cases.
 */
export function classifyGitError(stderr: string): GitFailureKind {
  const s = (stderr || '').toLowerCase();
  if (!s) return 'unknown';
  // Wording pinned against git 2.50.1; each pattern has a test case.
  if (s.includes('not a git repository')) return 'not-a-repo';
  // `a branch named 'x' already exists` -- must be tested before the bare
  // `already exists` fallback, which is the path case.
  if (/a branch named .* already exists/.test(s)) return 'branch-exists';
  // `'x' is already used by worktree at '...'` (2.5x) / `is already checked out at`.
  if (s.includes('is already used by worktree') || s.includes('is already checked out at')) {
    return 'branch-checked-out';
  }
  // git refuses this even with --force, which makes it a genuine floor under
  // the `ownsWorktree` flag rather than a second opinion.
  if (s.includes('is a main working tree')) return 'main-worktree';
  if (s.includes('is already registered')) return 'path-in-use';
  if (
    s.includes('invalid reference') ||
    s.includes('is not a valid branch') ||
    s.includes('not a valid object name') ||
    s.includes('unknown revision') ||
    s.includes('ambiguous argument')
  ) {
    return 'base-missing';
  }
  if (s.includes('not fully merged')) return 'branch-not-merged';
  if (s.includes('contains modified or untracked files') || s.includes('is dirty')) return 'dirty';
  if (s.includes('is not a working tree') || s.includes('no such file or directory')) {
    return 'not-found';
  }
  if (s.includes('already exists')) return 'path-exists';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// The one place that spawns a process
// ---------------------------------------------------------------------------

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Swappable runner. Production uses the Tauri shell plugin; tests can inject a
 * fake without mocking module internals.
 */
export type GitRunner = (
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
) => Promise<GitResult>;

let runner: GitRunner = async (args, cwd, env) => {
  // Lazy import: keeps `@tauri-apps/plugin-shell` out of the module graph for
  // the pure-parser unit tests, which run in plain node.
  const { Command } = await import('@tauri-apps/plugin-shell');
  const opts = cwd || env ? { ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) } : undefined;
  const child = await Command.create('git', args, opts).execute();
  return { code: child.code, stdout: child.stdout, stderr: child.stderr };
};

/** Test seam. Returns the previous runner so a test can restore it. */
export function setGitRunner(next: GitRunner): GitRunner {
  const prev = runner;
  runner = next;
  return prev;
}

/** Does this path exist? Swappable for the same reason as {@link GitRunner}. */
export type PathExistsProbe = (path: string) => Promise<boolean>;

let pathExists: PathExistsProbe = async (path) => {
  const fs = await import('@tauri-apps/plugin-fs');
  return fs.exists(path);
};

/** Whether anything is at `path`, through the same swappable probe. */
export function probePath(path: string): Promise<boolean> {
  return pathExists(path);
}

/** Test seam. Returns the previous probe so a test can restore it. */
export function setPathExistsProbe(next: PathExistsProbe): PathExistsProbe {
  const prev = pathExists;
  pathExists = next;
  return prev;
}

/** Run git and return the raw result without throwing. */
export async function git(
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<GitResult> {
  assertSafeArgv(args);
  return runner(args, cwd, env);
}

/** Run git, throw {@link GitError} on a non-zero exit, return trimmed stdout. */
export async function gitOk(args: string[], cwd?: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) {
    throw new GitError({ args, cwd, code: r.code, stderr: r.stderr, stdout: r.stdout });
  }
  return r.stdout;
}

/**
 * Last line of defence. Arguments are passed as an array so there is no shell
 * to inject into, but an argument that *starts with a dash* is still read by
 * git as an option, which is a real (if lesser) hazard. Any value that could be
 * attacker- or typo-controlled is routed through here.
 */
export function assertSafeArgv(args: string[]): void {
  for (const a of args) {
    if (typeof a !== 'string') throw new Error('git argv must be strings');
    if (a.includes('\0')) throw new Error('git argv must not contain NUL');
  }
}

/** Reject a value that git would mistake for an option. */
function assertNotOptionLike(value: string, what: string): void {
  if (value.startsWith('-')) {
    throw new Error(`Refusing to pass a ${what} that starts with "-": ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/** A `git worktree list --porcelain` record, with everything git told us. */
export interface ParsedWorktree extends WorktreeInfo {
  bare: boolean;
  detached: boolean;
  lockedReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * The format is line-oriented: records are separated by a blank line, each
 * record starts with `worktree <path>`, and subsequent lines are either
 * `<label> <value>` or a bare `<label>`. We parse the labels rather than
 * regexing the human-readable output, because the human output aligns columns
 * with spaces and a path containing spaces makes it ambiguous.
 */
export function parseWorktreePorcelain(stdout: string): ParsedWorktree[] {
  const out: ParsedWorktree[] = [];
  let cur: ParsedWorktree | null = null;

  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };

  for (const raw of (stdout ?? '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') {
      flush();
      continue;
    }
    const sp = line.indexOf(' ');
    const label = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);

    if (label === 'worktree') {
      flush();
      cur = {
        path: value,
        branch: null,
        head: '',
        locked: false,
        bare: false,
        detached: false,
        lockedReason: null,
        prunable: false,
        prunableReason: null,
      };
      continue;
    }
    if (!cur) continue; // stray line before any `worktree` header

    switch (label) {
      case 'HEAD':
        cur.head = value;
        break;
      case 'branch':
        cur.branch = shortenRef(value);
        break;
      case 'bare':
        cur.bare = true;
        break;
      case 'detached':
        cur.detached = true;
        break;
      case 'locked':
        cur.locked = true;
        cur.lockedReason = value || null;
        break;
      case 'prunable':
        cur.prunable = true;
        cur.prunableReason = value || null;
        break;
      default:
        break; // forward-compatible: unknown labels are ignored, not fatal
    }
  }
  flush();
  return out;
}

/** `refs/heads/foo` -> `foo`; `refs/remotes/origin/foo` -> `origin/foo`. */
export function shortenRef(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length);
  if (ref.startsWith('refs/tags/')) return ref.slice('refs/tags/'.length);
  return ref;
}

/** One entry from `git status --porcelain=v1 -z`. */
export interface StatusEntry {
  /** Index status char, or ' '. `?` for untracked, `!` for ignored. */
  x: string;
  /** Worktree status char, or ' '. */
  y: string;
  path: string;
  /** Source path for a rename/copy, else null. */
  origPath: string | null;
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all`.
 *
 * NUL-separated rather than newline-separated on purpose: a path containing a
 * newline or a quote is otherwise re-encoded by git with C-style escaping, and
 * a confirmation dialog that mangles a filename is a confirmation dialog the
 * user cannot trust. With `-z`, a rename/copy emits the destination record
 * followed by the source path as its own NUL-terminated field.
 */
export function parseStatusPorcelain(stdout: string): StatusEntry[] {
  const fields = (stdout ?? '').split('\0');
  const entries: StatusEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const rec = fields[i];
    i += 1;
    if (rec === undefined || rec.length < 4) continue; // "XY p" is the minimum
    const x = rec.charAt(0);
    const y = rec.charAt(1);
    const path = rec.slice(3);
    if (path.length === 0) continue;
    let origPath: string | null = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const orig = fields[i];
      if (orig !== undefined && orig.length > 0) {
        origPath = orig;
        i += 1;
      }
    }
    entries.push({ x, y, path, origPath });
  }
  return entries;
}

/** Human label for a status entry, used by the removal confirmation dialog. */
export function describeStatusEntry(e: StatusEntry): string {
  const code = `${e.x}${e.y}`;
  if (e.origPath) return `${code} ${e.origPath} -> ${e.path}`;
  return `${code} ${e.path}`;
}

/**
 * Parse the output of `git rev-list --count <range>`.
 *
 * Strict on purpose: a count we cannot read must not quietly become 0. Zero is
 * the answer that lets the UI say "nothing will be lost", so guessing it is the
 * one failure mode this whole check exists to prevent.
 */
/** Lines added and deleted in one file. Null for a binary file. */
export interface LineChange {
  added: number | null;
  deleted: number | null;
}

/**
 * `git diff --numstat --no-renames` output, keyed by path. Binary files report
 * `-` for both counts, which becomes null. Renames are disabled at the call so
 * every line is a plain `<added>\t<deleted>\t<path>`.
 */
export function parseNumstat(stdout: string): Map<string, LineChange> {
  const out = new Map<string, LineChange>();
  for (const line of stdout.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const n = (v: string | undefined) => (v === undefined || v === '-' ? null : Number(v));
    out.set(m[3] as string, { added: n(m[1]), deleted: n(m[2]) });
  }
  return out;
}

/**
 * The commit a task's changes are measured from: where its branch left
 * `baseBranch` -- or that branch's upstream, when it has one. A local `master`
 * that has not been pulled is behind `origin/master`; a branch rebased onto
 * origin would otherwise diff against a stale point and drag in every upstream
 * change since. Null when there is no merge base (a base that no longer
 * exists), which callers read as "uncommitted changes only".
 */
export async function taskBase(worktreePath: string, baseBranch: string): Promise<string | null> {
  try {
    assertSafeArgv([baseBranch]);
    let base = baseBranch;
    try {
      const up = (await gitOk(['rev-parse', '--abbrev-ref', `${baseBranch}@{upstream}`], worktreePath)).trim();
      if (up) base = up;
    } catch {
      /* no upstream: the local branch is the base */
    }
    return (await gitOk(['merge-base', base, 'HEAD'], worktreePath)).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Lines changed per file in a worktree: everything the task did relative to
 * {@link taskBase} -- committed on the branch AND still uncommitted -- which is
 * what "this task's changes" means. Untracked files are not in a diff and are
 * absent here.
 */
export async function lineChanges(worktreePath: string, baseBranch: string): Promise<Map<string, LineChange>> {
  const against = (await taskBase(worktreePath, baseBranch)) ?? 'HEAD';
  return parseNumstat(await gitOk(['diff', '--numstat', '--no-renames', against], worktreePath));
}

/** How a file differs from the task's base: added, modified, deleted, or its type changed. */
export type ChangeKind = 'A' | 'M' | 'D' | 'T';

/**
 * `git diff --name-status --no-renames` output, keyed by path. With renames
 * off every line is `<letter>\t<path>`; anything else is skipped.
 */
export function parseNameStatus(stdout: string): Map<string, ChangeKind> {
  const out = new Map<string, ChangeKind>();
  for (const line of stdout.split('\n')) {
    const m = /^([AMDT])\t(.+)$/.exec(line);
    if (m) out.set(m[2] as string, m[1] as ChangeKind);
  }
  return out;
}

/** The change kind per file, over the same range as {@link lineChanges}. */
export async function changeKinds(worktreePath: string, baseBranch: string): Promise<Map<string, ChangeKind>> {
  const against = (await taskBase(worktreePath, baseBranch)) ?? 'HEAD';
  return parseNameStatus(await gitOk(['diff', '--name-status', '--no-renames', against], worktreePath));
}

/**
 * `git log --format=%x00%ct --name-only` output: path -> the newest commit
 * time (ms) that touched it. Records are a NUL-prefixed timestamp line
 * followed by the paths that commit changed.
 */
export function parseCommitFileTimes(stdout: string): Map<string, number> {
  const out = new Map<string, number>();
  let at: number | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('\u0000')) {
      const n = Number(line.slice(1));
      at = Number.isFinite(n) ? n * 1000 : null;
      continue;
    }
    if (line === '' || at === null) continue;
    const prev = out.get(line);
    if (prev === undefined || at > prev) out.set(line, at);
  }
  return out;
}

/** When each file was last committed on the task's branch. Empty when unknown. */
export async function committedFileTimes(worktreePath: string, baseBranch: string): Promise<Map<string, number>> {
  const base = await taskBase(worktreePath, baseBranch);
  if (base === null) return new Map();
  return parseCommitFileTimes(
    await gitOk(['log', '--format=%x00%ct', '--name-only', '--no-renames', `${base}..HEAD`], worktreePath),
  );
}

/** One commit on the task's branch, with the files it changed. */
export interface BranchCommit {
  sha: string;
  /** Commit time, ms. */
  at: number;
  subject: string;
  files: Map<string, LineChange>;
}

/**
 * `git log --format=%x00%H%x09%ct%x09%s --numstat --no-renames` output, newest
 * first as git prints it. Each record is a NUL-prefixed header line followed
 * by numstat lines.
 */
export function parseCommitLog(stdout: string): BranchCommit[] {
  const out: BranchCommit[] = [];
  let cur: BranchCommit | null = null;
  for (const raw of stdout.split('\n')) {
    if (raw.startsWith('\u0000')) {
      const [sha, ct, ...rest] = raw.slice(1).split('\t');
      const at = Number(ct) * 1000;
      if (!sha || !Number.isFinite(at)) {
        cur = null;
        continue;
      }
      cur = { sha, at, subject: rest.join('\t'), files: new Map() };
      out.push(cur);
      continue;
    }
    if (cur === null) continue;
    for (const [path, change] of parseNumstat(raw)) cur.files.set(path, change);
  }
  return out;
}

/** The commits on the task's branch since it left its base, newest first. */
export async function branchCommits(worktreePath: string, baseBranch: string): Promise<BranchCommit[]> {
  const base = await taskBase(worktreePath, baseBranch);
  if (base === null) return [];
  return parseCommitLog(
    await gitOk(['log', '--format=%x00%H%x09%ct%x09%s', '--numstat', '--no-renames', `${base}..HEAD`], worktreePath),
  );
}

export function parseCommitCount(stdout: string): number {
  const t = (stdout ?? '').trim();
  if (!/^\d+$/.test(t)) {
    throw new Error(`Could not read a commit count from git: ${JSON.stringify(stdout)}`);
  }
  return Number(t);
}

/**
 * Parse `git rev-parse --abbrev-ref --symbolic-full-name @{u}`.
 *
 * Returns null when there is no upstream -- git exits non-zero in that case
 * ("no upstream configured for branch 'x'", or "HEAD does not point to a
 * branch" when detached), so the caller passes an empty string for a failure.
 */
export function parseUpstream(stdout: string): string | null {
  const t = (stdout ?? '').trim();
  if (!t || t === '@{u}' || t.includes('\n')) return null;
  return t;
}

/**
 * Compose a `<base>..HEAD` rev range, validating the base first.
 *
 * This is where an option-like base branch would otherwise become dangerous:
 * the range is a single argv element beginning with the base, so a base of
 * `--all` would arrive at git as the option `--all..HEAD`. Pure and exported
 * so the validation has its own test.
 */
export function revRange(base: string, head = 'HEAD'): string {
  assertValidRefName(base, 'base branch');
  return `${base}..${head}`;
}

/** Parse the newline-separated output of `git for-each-ref --format=...`. */
export function parseRefList(stdout: string): string[] {
  return (stdout ?? '')
    .split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l).trim())
    .filter((l) => l.length > 0);
}

/**
 * Compose `<worktreeRoot>/<slug>`. Pure, so the layout is testable without a
 * Tauri host, and so the dialog can show the path live while the user types.
 *
 * Note there is no `<repo>` segment any more: the root is per-project, so the
 * directory the user chose *is* the namespace. Inserting a segment of our own
 * would defeat the point of letting them choose.
 */
export function composeWorktreePath(worktreeRoot: string, slug: string, home = ''): string {
  const root = normalizePath(home ? expandTilde(worktreeRoot, home) : worktreeRoot);
  return `${root.replace(/\/+$/, '')}/${slug.replace(/^\/+|\/+$/g, '')}`;
}

/** Suggested worktree root for a new project, in the `~`-relative form the
 * migration backfill also uses. Only a default -- the user can change it. */
export function defaultWorktreeRoot(projectName: string): string {
  const safe = projectName.trim().replace(/^\/+|\/+$/g, '') || 'project';
  return `~/agents/${safe}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive the repository root from `git rev-parse --git-common-dir` output.
 *
 * Pure, so the layout rules are testable without a repo. Returns null when the
 * shape is not one we can reason about, so the caller falls back rather than
 * inventing a path.
 *
 *   /repo/.git      + not bare  ->  /repo
 *   /srv/mirror.git + bare      ->  /srv/mirror.git   (the repo IS the dir)
 *   .git (relative)             ->  null              (see below)
 *   /elsewhere.git  + not bare  ->  null              (--separate-git-dir)
 *
 * The relative case is not hypothetical: without `--path-format=absolute`,
 * `rev-parse --git-common-dir` run in the main repo prints the literal string
 * `.git`. A project whose repo_path was `.git` would be a memorable bug, so it
 * is refused here rather than anywhere further downstream.
 */
export function repoRootFromCommonDir(commonDir: string, isBare: boolean): string | null {
  const dir = normalizePath((commonDir ?? '').trim());
  if (!dir.startsWith('/')) return null;
  if (isBare) return dir;
  if (dir === '/.git') return null;
  if (dir.endsWith('/.git')) return dir.slice(0, -'/.git'.length);
  return null;
}

/**
 * **The repository a directory belongs to** — the identity key for project
 * association, and the answer to "are these two directories the same repo?".
 *
 * Returns the same path whether called in the main checkout, in a linked
 * worktree, or in a subdirectory of either. That is the whole point:
 * {@link repoToplevel} cannot do this, because inside a worktree it returns the
 * *worktree*, so a task running in a worktree of acme never matched the
 * acme project and fell into the "Other" tab.
 *
 * Use this for identity. Use {@link repoToplevel} when you genuinely mean the
 * current working tree — `uncommittedChanges` and friends are right to.
 *
 * Known limit: with `git init --separate-git-dir`, the common dir is unrelated
 * to the working tree and cannot be mapped back to it, so this falls back to
 * the current working tree. Two linked worktrees of such a repo would not agree
 * with each other. It is a rare configuration and a wrong-but-usable answer
 * beats a confidently wrong one.
 */
export async function repoRootFor(path: string): Promise<string> {
  const out = await gitOk(
    ['rev-parse', '--path-format=absolute', '--git-common-dir', '--is-bare-repository'],
    path,
  );
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const root = repoRootFromCommonDir(lines[0] ?? '', (lines[1] ?? '') === 'true');
  if (root !== null) return root;

  // Unusual layout. A real working tree is more useful to the user than a
  // gitdir, even though it is a weaker identity key.
  const top = (await gitOk(['rev-parse', '--show-toplevel'], path)).trim();
  if (top.length === 0) {
    throw new Error(`Could not determine the repository root for ${path}`);
  }
  return normalizePath(top);
}

/**
 * Toplevel of the **current working tree**. Inside a linked worktree this is
 * the worktree, not the repository — which is correct for questions about what
 * is checked out here, and wrong for questions about which repo this is. For
 * the latter use {@link repoRootFor}.
 */
export async function repoToplevel(repoPath: string): Promise<string> {
  const out = await gitOk(['rev-parse', '--show-toplevel'], repoPath);
  const top = out.trim();
  if (!top) {
    throw new Error(`Could not determine the git toplevel for ${repoPath}`);
  }
  return top;
}

/**
 * Basename of the repository, e.g. `/Users/x/www/albedo` -> `albedo`.
 * Keyed on {@link repoRootFor}, so a worktree of a repo is named after the
 * repo rather than after the worktree folder.
 */
export async function repoName(repoPath: string): Promise<string> {
  return basename(await repoRootFor(repoPath));
}

/** Pure basename, so `repoName` has no Tauri dependency beyond the git call. */
export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * The repo's default branch, as a local name (`main`), or null.
 *
 * What a task should be compared against when nobody chose a base: the
 * branch `origin/HEAD` points at, else a local `main` or `master`. Never the
 * task's own branch -- a base equal to the branch makes every "what did this
 * task do" question answer "nothing" (and hides its PR), which is what a task
 * resumed from History used to record.
 */
export async function defaultBranchOf(repoPath: string): Promise<string | null> {
  const head = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repoPath).catch(() => null);
  const remote = head?.code === 0 ? head.stdout.trim() : '';
  const fromRemote = remote.includes('/') ? remote.slice(remote.indexOf('/') + 1) : '';
  if (fromRemote && isValidRefName(fromRemote)) return fromRemote;
  for (const name of ['main', 'master']) {
    const r = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], repoPath).catch(() => null);
    if (r?.code === 0) return name;
  }
  return null;
}

/**
 * Local branches plus remote-tracking branches (so a task can be based off
 * `origin/main` without fetching first), and the currently checked-out branch.
 *
 * On a detached HEAD, `current` is the short commit id and is NOT included in
 * `all` -- the dialog shows it as a hint but the user must pick a real base.
 */
export interface BranchList {
  current: string;
  /** Local branches first, then remote ones not named the same. */
  all: string[];
  locals: string[];
  /** Remote branches as `<remote>/<branch>`, without `<remote>/HEAD`. */
  remoteRefs: string[];
  /** `git remote`, to tell a remote ref's remote from a slash in a branch. */
  remotes: string[];
}

export async function listBranches(repoPath: string): Promise<BranchList> {
  const locals = parseRefList(
    await gitOk(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repoPath),
  );
  let remotes: string[] = [];
  const r = await git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], repoPath);
  if (r.code === 0) {
    remotes = parseRefList(r.stdout).filter((b) => !b.endsWith('/HEAD'));
  }

  let current = '';
  const sym = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoPath);
  if (sym.code === 0) {
    current = sym.stdout.trim();
  } else {
    const head = await git(['rev-parse', '--short', 'HEAD'], repoPath);
    current = head.code === 0 ? head.stdout.trim() : '';
  }

  const names = await git(['remote'], repoPath);
  const remoteNames = names.code === 0 ? parseRefList(names.stdout) : [];

  const seen = new Set<string>();
  const all: string[] = [];
  for (const b of [...locals, ...remotes]) {
    if (!seen.has(b)) {
      seen.add(b);
      all.push(b);
    }
  }
  return { current, all, locals, remoteRefs: remotes, remotes: remoteNames };
}

/** How to have a local branch for `ref`, picked from {@link BranchList.all}. */
export interface LocalCheckout {
  /** The local branch the task will be on. */
  branch: string;
  /** The remote ref to cut `branch` from with `--track`; null when it exists. */
  track: string | null;
}

/**
 * `origin/anna/fix-tz` becomes the local `anna/fix-tz`, tracking it -- unless a
 * local branch of that name exists already, which is then used as it is. The
 * remote is matched against `git remote`, longest first, because a branch may
 * itself contain slashes. Pure.
 */
export function localCheckoutFor(
  ref: string,
  list: Pick<BranchList, 'locals' | 'remotes'>,
): LocalCheckout {
  if (list.locals.includes(ref)) return { branch: ref, track: null };
  const remote = [...list.remotes]
    .sort((a, b) => b.length - a.length)
    .find((r) => ref.startsWith(`${r}/`) && ref.length > r.length + 1);
  if (!remote) return { branch: ref, track: null };
  const branch = ref.slice(remote.length + 1);
  return { branch, track: list.locals.includes(branch) ? null : ref };
}

/**
 * The base `ref` most likely branched from, when no pull request says: of the
 * usual candidates, the one with the fewest commits on `ref` that it lacks.
 * Ties go to the earlier candidate, so the caller lists its preference first.
 * Null when none can be compared.
 */
export async function guessBaseBranch(
  repoPath: string,
  ref: string,
  candidates: readonly string[],
): Promise<{ base: string; ahead: number } | null> {
  assertNotOptionLike(ref, 'branch');
  let best: { base: string; ahead: number } | null = null;
  for (const base of new Set(candidates)) {
    if (base === ref || base.startsWith('-')) continue;
    const r = await git(['rev-list', '--count', `${base}..${ref}`], repoPath).catch(() => null);
    const ahead = r?.code === 0 ? Number.parseInt(r.stdout.trim(), 10) : Number.NaN;
    if (Number.isFinite(ahead) && (best === null || ahead < best.ahead)) best = { base, ahead };
  }
  return best;
}

/**
 * `git fetch --all --prune`: what colleagues pushed, minus what they deleted.
 * Never prompts (no terminal is attached): a credential problem fails at
 * once, and git's stderr says why.
 */
export async function fetchAll(repoPath: string): Promise<void> {
  const args = ['fetch', '--all', '--prune', '--quiet'];
  const r = await git(args, repoPath, { GIT_TERMINAL_PROMPT: '0' });
  if (r.code !== 0) throw new GitError({ args, cwd: repoPath, code: r.code, stderr: r.stderr, stdout: r.stdout });
}

/** The repository's main working tree, as a place a task can run in. */
export interface MainCheckout {
  path: string;
  /** Its branch; null when detached. */
  current: string | null;
  /** Uncommitted changes; null when unreadable. Only 0 allows a switch. */
  dirty: number | null;
}

/** Null when the repo has none (bare) or git cannot say. Never throws. */
export async function probeMainCheckout(repoPath: string): Promise<MainCheckout | null> {
  try {
    // `worktree list` always lists the main working tree first.
    const first = (await listWorktreesDetailed(repoPath))[0];
    if (!first || first.bare || first.prunable) return null;
    const dirty = await uncommittedChanges(first.path).then((c) => c.files.length, () => null);
    return { path: first.path, current: first.branch, dirty };
  } catch {
    return null;
  }
}

export interface SwitchCheckoutOptions {
  path: string;
  branch: string;
  /** Cut `branch` from this (`switch -c`); omitted, `branch` must exist. */
  from?: string;
  /** With `from`, a remote branch to track. */
  track?: boolean;
}

/**
 * `git switch` in a working tree that is the user's own -- the main checkout.
 * Refuses unless it is clean *now*: anything the caller counted earlier is
 * stale, and nothing in this folder may be carried onto another branch unasked.
 */
export async function switchCleanCheckout(o: SwitchCheckoutOptions): Promise<void> {
  assertValidRefName(o.branch, 'branch');
  if (o.from !== undefined) assertNotOptionLike(o.from, 'start point');
  const args =
    o.from === undefined
      ? ['switch', o.branch]
      : // --no-track as for worktrees: a new branch cut from `origin/main` must
        // not push to main.
        ['switch', o.track ? '--track' : '--no-track', '-c', o.branch, o.from];
  const changes = await uncommittedChanges(o.path);
  if (changes.files.length > 0) {
    throw new GitError({
      args,
      cwd: o.path,
      code: null,
      stdout: '',
      stderr: `${o.path} now has ${changes.files.length} uncommitted change(s). Commit or stash them first; nothing was switched.`,
      kind: 'dirty',
    });
  }
  await gitOk(args, o.path);
}

/**
 * `<project.worktreeRoot>/<slug>`, with a leading `~` resolved through the
 * Tauri path API.
 */
export async function worktreePathFor(project: Project, slug: string): Promise<string> {
  const { homeDir } = await import('@tauri-apps/api/path');
  const home = await homeDir();
  return composeWorktreePath(project.worktreeRoot, slug, home);
}

export interface CreateWorktreeOptions {
  repoPath: string;
  baseBranch: string;
  branch: string;
  path: string;
  /**
   * Opt-in retry path. When git reports that `branch` already exists,
   * `createWorktree` throws `GitError` with `kind === 'branch-exists'` rather
   * than guessing; the caller asks the user, then calls again with this set to
   * check out the existing branch (`git worktree add <path> <branch>`).
   */
  useExistingBranch?: boolean;
  /**
   * `baseBranch` is a remote branch to check out locally: `-b` cuts `branch`
   * from it with `--track`, so pulling and pushing go where it came from.
   */
  track?: boolean;
  /**
   * What `-b` cuts from, when not `baseBranch` itself: its upstream
   * (`origin/main`) when the local branch is behind -- see {@link cutPoint}.
   * The task still records `baseBranch`; only the starting commit differs.
   */
  startPoint?: string;
}

/**
 * `git worktree add -b <branch> <path> <baseBranch>` (or, with
 * `useExistingBranch`, `git worktree add <path> <branch>`; with `track`,
 * `--track` is added).
 *
 * Uncommitted changes in the origin repo are fine and are deliberately not
 * checked: a worktree is an independent checkout.
 */
export async function createWorktree(o: CreateWorktreeOptions): Promise<void> {
  assertValidRefName(o.branch, 'branch');
  assertNotOptionLike(o.path, 'worktree path');
  if (!o.useExistingBranch) {
    assertValidRefName(o.baseBranch, 'base branch');
    if (o.startPoint) assertValidRefName(o.startPoint, 'start point');
  }

  // Refuse an existing path rather than writing into it. git only objects when
  // the directory is non-empty, so without this an empty folder the user had
  // made for something else would quietly become a worktree.
  let exists = false;
  try {
    exists = await pathExists(o.path);
  } catch {
    // Cannot check (fs scope, permissions): fall through and let git decide,
    // which is still safe for the non-empty case.
    exists = false;
  }
  if (exists) {
    throw new GitError({
      args: ['worktree', 'add'],
      cwd: o.repoPath,
      code: null,
      stdout: '',
      stderr: `${o.path} already exists. Choose a different task title, or remove that directory first.`,
      kind: 'path-exists',
    });
  }

  const args = o.useExistingBranch
    ? ['worktree', 'add', '--', o.path, o.branch]
    : // --track for a colleague's remote branch, so pull and push go where it
      // came from. Otherwise --no-track: cut from `origin/main`, git would make
      // that the new branch's upstream, and a later push would aim at main.
      [
        'worktree', 'add', o.track ? '--track' : '--no-track',
        '-b', o.branch, '--', o.path, o.startPoint ?? o.baseBranch,
      ];

  const r = await git(args, o.repoPath);
  if (r.code !== 0) {
    throw new GitError({
      args,
      cwd: o.repoPath,
      code: r.code,
      stderr: r.stderr,
      stdout: r.stdout,
    });
  }
}

/** Every worktree git knows about for this repo, main worktree included. */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  return listWorktreesDetailed(repoPath);
}

/** Same as {@link listWorktrees} but keeps the bare/detached/prunable flags. */
export async function listWorktreesDetailed(repoPath: string): Promise<ParsedWorktree[]> {
  const stdout = await gitOk(['worktree', 'list', '--porcelain'], repoPath);
  return parseWorktreePorcelain(stdout);
}

export interface UncommittedChanges {
  files: string[];
  dirty: boolean;
  /** Status codes kept alongside the paths, for the confirmation dialog. */
  entries: StatusEntry[];
}

/**
 * Uncommitted changes in a worktree, **including untracked files**.
 *
 * Under-reporting here is the dangerous direction: this feeds the "are you sure
 * you want to delete this worktree" dialog, so untracked files are requested
 * explicitly with `--untracked-files=all` (not `normal`, which collapses an
 * untracked directory to a single entry).
 */
export async function uncommittedChanges(worktreePath: string): Promise<UncommittedChanges> {
  const stdout = await gitOk(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    worktreePath,
  );
  const entries = parseStatusPorcelain(stdout);
  return {
    entries,
    files: entries.map(describeStatusEntry),
    dirty: entries.length > 0,
  };
}

export interface UnmergedCommits {
  /** Commits on HEAD that are not reachable from the comparison base. */
  ahead: number;
  /** The configured upstream, or null when the branch has none. */
  upstream: string | null;
}

/**
 * How many commits in a worktree are not merged anywhere else yet.
 *
 * Deliberately separate from {@link uncommittedChanges}, which stays
 * working-tree-only: these are two different kinds of loss and the
 * confirmation dialog names them separately.
 *
 * The comparison base is the branch's own upstream when it has one -- that is
 * the honest question, "has this been pushed?" -- and `baseBranch` otherwise.
 *
 * Throws rather than returning 0 when the count cannot be established. A
 * cleanup tool that reports "0 commits will be lost" because git errored is
 * worse than one that admits it does not know.
 */
export async function unmergedCommits(
  worktreePath: string,
  baseBranch: string,
): Promise<UnmergedCommits> {
  const up = await git(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    worktreePath,
  );
  const upstream = up.code === 0 ? parseUpstream(up.stdout) : null;

  const base = upstream ?? baseBranch;
  const args = ['rev-list', '--count', revRange(base), '--'];
  const r = await git(args, worktreePath);
  if (r.code !== 0) {
    throw new GitError({
      args,
      cwd: worktreePath,
      code: r.code,
      stderr: r.stderr,
      stdout: r.stdout,
    });
  }
  return { ahead: parseCommitCount(r.stdout), upstream };
}

// ---------------------------------------------------------------------------
// Describing what a removal would destroy.
//
// Pure, and shared by both confirmation dialogs (ArchiveTaskDialog and
// WorktreeReconcile) so the two can never drift into saying different things
// about the same situation. Tested directly -- the wording IS the safety
// mechanism, so it gets the same treatment as the parsers.
// ---------------------------------------------------------------------------

/** Everything we managed to find out about the work sitting in a worktree. */
export interface WorkAtRisk {
  /** Uncommitted files (see {@link describeStatusEntry}); null = unreadable. */
  files: string[] | null;
  /** Commits not merged into {@link aheadBase}; null = could not establish. */
  ahead: number | null;
  aheadBase: string | null;
  /**
   * The commit HEAD pointed at when this was probed; null = unreadable.
   * Optional so a hand-built value stays valid -- but an acknowledgement taken
   * without it cannot tell "same commits" from "different commits, same
   * count", so {@link riskGrew} treats its absence as a change.
   */
  head?: string | null;
}

/** {@link WorkAtRisk} plus git's own words for whatever could not be read. */
export interface WorkProbe {
  risk: WorkAtRisk;
  filesError: string | null;
  aheadError: string | null;
}

/**
 * Probe everything {@link assessLoss} needs, in one place, so the dialogs'
 * first look and {@link removeWorktree}'s last look cannot ask different
 * questions. `baseBranch` null means there is nothing to compare against, which
 * is an unknown, never a zero. Never throws: what cannot be read is reported.
 */
export async function probeWorkAtRisk(
  worktreePath: string,
  baseBranch: string | null,
): Promise<WorkProbe> {
  const risk: WorkAtRisk = { files: null, ahead: null, aheadBase: baseBranch, head: null };
  let filesError: string | null = null;
  let aheadError: string | null = null;
  try {
    risk.files = (await uncommittedChanges(worktreePath)).files;
  } catch (e) {
    filesError = e instanceof Error ? e.message : String(e);
  }
  if (baseBranch === null) {
    aheadError = 'No base branch to compare against, so unmerged commits are unknown.';
  } else {
    try {
      const un = await unmergedCommits(worktreePath, baseBranch);
      risk.ahead = un.ahead;
      risk.aheadBase = un.upstream ?? baseBranch;
    } catch (e) {
      aheadError = e instanceof Error ? e.message : String(e);
    }
  }
  // Caught like the two above: a worktree folder deleted behind Albedo's back
  // makes the spawn itself reject (no such cwd), and an unknown HEAD is null.
  try {
    const h = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], worktreePath);
    const head = h.code === 0 ? h.stdout.trim() : '';
    risk.head = /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  } catch {
    risk.head = null;
  }
  return { risk, filesError, aheadError };
}

/**
 * Has the work at risk grown since the user acknowledged losing it?
 *
 * The acknowledgement names what was on screen. Claude keeps working while the
 * dialog is open, so by the time Confirm is clicked there may be more: a new
 * file, or commits that `branch -D` would destroy without ever having been
 * shown. Anything new, or anything that has become unreadable, is growth.
 * Shrinking is not -- committing a file the user already agreed to lose only
 * moves it somewhere safer.
 *
 * Commits are compared by HEAD as well as by count: a reset-and-recommit can
 * keep the count while replacing every commit the user was told about.
 */
export function riskGrew(acked: WorkAtRisk, now: WorkAtRisk, plan: LossPlan): boolean {
  if (now.files === null && acked.files !== null) return true;
  if (now.files !== null && acked.files !== null) {
    const seen = new Set(acked.files);
    if (now.files.some((f) => !seen.has(f))) return true;
  }
  if (!plan.deleteBranch) return false; // committed work survives on the branch
  if (now.ahead === null) return acked.ahead !== null;
  if (now.ahead === 0) return false; // nothing unmerged: nothing for -D to destroy
  if (acked.ahead === null) return false; // already acknowledged as unknown
  if (now.ahead > acked.ahead) return true;
  if (now.aheadBase !== acked.aheadBase) return true;
  return (now.head ?? null) === null || (now.head ?? null) !== (acked.head ?? null);
}

/**
 * Thrown by {@link removeWorktree} instead of removing anything when the work
 * at risk grew after it was acknowledged. Carries the fresh probe so the dialog
 * can show the new facts and ask again.
 */
export class RiskChangedError extends Error {
  readonly now: WorkProbe;
  constructor(now: WorkProbe) {
    super(
      'The worktree changed after you confirmed: there is more at risk than you were shown. ' +
        'Nothing was removed. Review the updated list and confirm again.',
    );
    this.name = 'RiskChangedError';
    this.now = now;
  }
}

/** The part of the user's choice that changes what is actually destroyed. */
export interface LossPlan {
  /** Whether the branch is deleted as well as the worktree. */
  deleteBranch: boolean;
}

export interface LossAssessment {
  /** Uncommitted work will be destroyed. */
  dirty: boolean;
  /** Committed-but-unmerged work will be destroyed. */
  unmerged: boolean;
  /** Something relevant to this plan could not be checked. */
  unknown: boolean;
  /** Whether the user must tick an acknowledgement before anything happens. */
  needsAck: boolean;
}

/**
 * What removing this worktree under this plan would actually destroy.
 *
 * The distinction that matters: uncommitted changes die with the worktree
 * whatever the user chooses, but **unmerged commits only die if the branch is
 * deleted too**. Keeping the branch is therefore a genuinely non-destructive
 * option for committed work, and the dialogs must not cry wolf about it.
 *
 * An unknown is treated as a loss. If we could not check, the user still
 * acknowledges before anything is deleted.
 */
export function assessLoss(w: WorkAtRisk, plan: LossPlan): LossAssessment {
  const dirty = w.files !== null && w.files.length > 0;
  const unmerged = plan.deleteBranch && w.ahead !== null && w.ahead > 0;
  const unknown = w.files === null || (plan.deleteBranch && w.ahead === null);
  return { dirty, unmerged, unknown, needsAck: dirty || unmerged || unknown };
}

/**
 * The sentence the user has to tick. Names every count explicitly -- "are you
 * sure?" is not a confirmation, "3 uncommitted change(s) and 2 commit(s) not
 * merged into origin/main will be permanently lost" is.
 */
export function ackLabel(w: WorkAtRisk, plan: LossPlan): string {
  const { dirty, unmerged, unknown } = assessLoss(w, plan);
  const parts: string[] = [];
  if (dirty) parts.push(`${w.files?.length ?? 0} uncommitted change(s)`);
  if (unmerged) {
    parts.push(`${w.ahead} commit(s) not merged into ${w.aheadBase ?? 'the base branch'}`);
  }
  if (parts.length === 0) {
    return unknown
      ? 'I understand Albedo could not check what is in this worktree, and that removing it may destroy work.'
      : 'I understand this worktree will be removed.';
  }
  const list = parts.join(' and ');
  return unknown
    ? `I understand ${list} will be permanently lost, and that some of this worktree could not be checked.`
    : `I understand ${list} will be permanently lost.`;
}

export interface RemoveWorktreeOptions {
  repoPath: string;
  path: string;
  branch: string | null;
  force: boolean;
  deleteBranch: boolean;
  /**
   * What the user saw when they ticked the acknowledgement, and the base it
   * was measured against. **Required when `force` is true**: forcing is only
   * ever justified by an acknowledgement, and an acknowledgement is only good
   * for the work it described. See {@link riskGrew}.
   */
  acknowledged?: { risk: WorkAtRisk; baseBranch: string | null };
}

/**
 * Remove a worktree, and optionally its branch.
 *
 *   git worktree remove [--force] -- <path>
 *   git branch -d|-D -- <branch>      (only when deleteBranch)
 *   git worktree prune
 *
 * Refuses to proceed when the worktree is dirty unless `force` is true. We
 * never delete the directory ourselves -- git owns that, and `prune` cleans up
 * the administrative files afterwards.
 *
 * With `force`, the work at risk is probed again immediately before anything
 * runs, and {@link RiskChangedError} is thrown if it grew since it was
 * acknowledged. The window that remains is the few milliseconds between this
 * probe and `worktree remove`, rather than however long the dialog sat open.
 */
export async function removeWorktree(o: RemoveWorktreeOptions): Promise<void> {
  assertNotOptionLike(o.path, 'worktree path');
  if (o.branch !== null) assertValidRefName(o.branch, 'branch');

  if (o.force) {
    if (!o.acknowledged) {
      throw new Error('Refusing to force-remove a worktree without the acknowledged state to check against.');
    }
    const now = await probeWorkAtRisk(o.path, o.acknowledged.baseBranch);
    const plan = { deleteBranch: o.deleteBranch && o.branch !== null };
    if (riskGrew(o.acknowledged.risk, now.risk, plan)) throw new RiskChangedError(now);
  }

  if (!o.force) {
    let status: UncommittedChanges | null = null;
    try {
      status = await uncommittedChanges(o.path);
    } catch {
      // The worktree directory may already be gone; `git worktree remove` will
      // report that far more precisely than we can here.
      status = null;
    }
    if (status?.dirty) {
      throw new GitError({
        args: ['status', '--porcelain'],
        cwd: o.path,
        code: 0,
        stdout: '',
        stderr:
          `Refusing to remove ${o.path}: ${status.files.length} uncommitted change(s).\n` +
          status.files.map((f) => `  ${f}`).join('\n'),
        kind: 'dirty',
      });
    }
  }

  const removeArgs = ['worktree', 'remove', ...(o.force ? ['--force'] : []), '--', o.path];
  await gitOk(removeArgs, o.repoPath);

  if (o.deleteBranch && o.branch) {
    const delArgs = ['branch', o.force ? '-D' : '-d', '--', o.branch];
    const r = await git(delArgs, o.repoPath);
    if (r.code !== 0) {
      // The worktree is already gone at this point, so we prune before
      // surfacing the branch failure -- otherwise the admin files linger.
      await git(['worktree', 'prune'], o.repoPath);
      throw new GitError({
        args: delArgs,
        cwd: o.repoPath,
        code: r.code,
        stderr: r.stderr,
        stdout: r.stdout,
      });
    }
  }

  await gitOk(['worktree', 'prune'], o.repoPath);
}

/**
 * Undo a {@link createWorktree} whose task row could not be written, so a
 * retry does not fail on `path-exists` against a worktree no task knows about.
 *
 * Never forced: the worktree was created moments ago and should be clean, and
 * if anything has already been written into it, `git worktree remove` refusing
 * is the right outcome. The branch is deleted only when this call created it
 * with `-b`, and then with `-d`, never `-D` -- a branch that was checked out
 * because it already existed belongs to the user.
 *
 * Returns null when everything was undone, otherwise a sentence naming exactly
 * what was left behind, for the dialog to show. Never throws.
 */
export async function undoCreateWorktree(o: CreateWorktreeOptions): Promise<string | null> {
  const createdBranch = !o.useExistingBranch;
  try {
    await removeWorktree({
      repoPath: o.repoPath,
      path: o.path,
      branch: createdBranch ? o.branch : null,
      force: false,
      deleteBranch: createdBranch,
    });
    return null;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // removeWorktree runs `branch -d` only after `worktree remove` succeeded.
    if (e instanceof GitError && e.args[0] === 'branch') {
      return `The worktree was removed, but the branch ${o.branch} was left behind:\n${why}`;
    }
    return (
      `The worktree at ${o.path} was left on disk` +
      (createdBranch ? ` and the branch ${o.branch} was kept` : '') +
      `. Remove it from Reconcile worktrees, or with git, before retrying:\n${why}`
    );
  }
}

/**
 * How close to the task row a branch's creation must be to count as Albedo's.
 * `git worktree add -b` runs immediately before the row is inserted, so the gap
 * is the database write; the slack absorbs a slow disk, not a human.
 */
const BRANCH_CREATION_WINDOW_BEFORE_S = 30;
const BRANCH_CREATION_WINDOW_AFTER_S = 5;

/**
 * The creation entry of a branch's reflog, from
 * `git reflog show --date=unix --format=%gd%x09%gs refs/heads/<b>`.
 *
 * The reflog lists newest first, so the creation is the LAST line -- and only
 * if that line actually says `branch: Created from`. When the creation entry
 * has expired, been renamed over, or the reflog is disabled, the oldest
 * surviving line is something else and this returns null: unknown, never a
 * guess.
 */
export function parseBranchCreation(stdout: string): { at: number } | null {
  const lines = (stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const m = /^\S+@\{(\d+)\}\t(.*)$/.exec(last);
  if (!m) return null;
  if (!(m[2] ?? '').startsWith('branch: Created from ')) return null;
  return { at: Number(m[1]) };
}

/**
 * Was the branch created by Albedo for this task (i.e. by `worktree add -b`)?
 *
 * Without a column recording it, the branch's own reflog is the only witness:
 * a branch Albedo cut was created within seconds of the task row, and one the
 * user already had -- "Check out the existing branch" -- was created earlier.
 * Pure; `taskCreatedAtMs` is the row's `createdAt`.
 */
export function branchCreatedWithTask(
  creation: { at: number } | null,
  taskCreatedAtMs: number,
): boolean {
  if (creation === null || !Number.isFinite(taskCreatedAtMs)) return false;
  const task = taskCreatedAtMs / 1000;
  return (
    creation.at >= task - BRANCH_CREATION_WINDOW_BEFORE_S &&
    creation.at <= task + BRANCH_CREATION_WINDOW_AFTER_S
  );
}

/**
 * Whether Albedo may offer to delete this task's branch. False whenever it
 * cannot be shown that the task created it -- deleting a branch the user
 * already had is never the right default, and "could not tell" is not
 * permission. Never throws.
 */
export async function taskCreatedBranch(
  repoPath: string,
  branch: string,
  taskCreatedAtMs: number,
): Promise<boolean> {
  if (!isValidRefName(branch)) return false;
  try {
    const r = await git(
      ['reflog', 'show', '--date=unix', '--format=%gd%x09%gs', `refs/heads/${branch}`, '--'],
      repoPath,
    );
    if (r.code !== 0) return false;
    return branchCreatedWithTask(parseBranchCreation(r.stdout), taskCreatedAtMs);
  } catch {
    return false;
  }
}

/**
 * Whether Albedo may offer to delete `task`'s branch: the recorded answer when
 * there is one, else (a task from before it was recorded) the reflog. Never
 * throws.
 */
export async function mayDeleteTaskBranch(task: {
  repoPath: string;
  branch: string;
  createdAt: number;
  createdBranch: boolean | null;
}): Promise<boolean> {
  if (task.createdBranch !== null) return task.createdBranch;
  return taskCreatedBranch(task.repoPath, task.branch, task.createdAt);
}

/** Re-exported from ./reconcile so the frozen module surface stays in one file. */
export { findOrphans } from './reconcile';
export type { OrphanInfo } from './reconcile';

/** Re-exported for callers that want to validate a hand-typed base branch. */
export { isValidRefName };

// ---------------------------------------------------------------------------
// Is the base up to date?
// ---------------------------------------------------------------------------

/**
 * How a local base branch stands against its upstream, after a fetch.
 *
 * A task cut from a stale local `main` starts behind, and its PR opens with
 * conflicts already in it. Local `main` usually cannot be fast-forwarded from
 * here -- it is checked out in the main checkout, which is the user's -- so
 * the fix is to cut from the upstream instead ({@link cutPoint}).
 */
export interface BaseFreshness {
  /** `origin/main`; null when the base tracks nothing. */
  upstream: string | null;
  /** Commits on the local base the upstream lacks: unpushed work. */
  ahead: number;
  /** Commits on the upstream the local base lacks. */
  behind: number;
  /** False when the fetch failed or timed out: the counts are as of the last fetch. */
  fetched: boolean;
}

/** `git rev-list --left-right --count base...upstream` → ahead, behind. */
export function parseAheadBehind(stdout: string): { ahead: number; behind: number } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(stdout);
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null;
}

/**
 * Where a new task should start. The upstream only when the local base is
 * strictly behind it: with unpushed commits on the local base, cutting from
 * the upstream would silently leave them out.
 */
export function cutPoint(baseBranch: string, f: BaseFreshness | null): string {
  return f?.upstream && f.behind > 0 && f.ahead === 0 ? f.upstream : baseBranch;
}

/** Long enough for a slow remote, short enough that New Task never feels stuck. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch `baseBranch`'s upstream and compare. Null when the base tracks nothing
 * or git cannot say. Never prompts: no terminal is attached, so a credential
 * prompt would hang until the timeout.
 */
export async function baseFreshness(
  repoPath: string,
  baseBranch: string,
): Promise<BaseFreshness | null> {
  assertValidRefName(baseBranch, 'base branch');
  const config = async (key: string) => {
    const r = await git(['config', '--get', `branch.${baseBranch}.${key}`], repoPath);
    return r.code === 0 ? r.stdout.trim() : '';
  };
  const [remote, merge] = await Promise.all([config('remote'), config('merge')]);
  // `.` is a local upstream: nothing to fetch, and nothing to be behind.
  if (!remote || !merge || remote === '.') return null;

  // Naming the branch without a destination still updates `origin/main`
  // (git's opportunistic remote-tracking update), and fetches nothing else.
  const fetch = git(['fetch', '--quiet', '--no-tags', '--', remote, merge], repoPath, {
    GIT_TERMINAL_PROMPT: '0',
  }).then((r) => r.code === 0, () => false);
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), FETCH_TIMEOUT_MS));
  const fetched = await Promise.race([fetch, timeout]);

  const up = await git(['rev-parse', '--abbrev-ref', `${baseBranch}@{upstream}`], repoPath);
  const upstream = up.code === 0 ? up.stdout.trim() : '';
  if (!upstream) return null;
  const counts = await git(['rev-list', '--left-right', '--count', `${baseBranch}...${upstream}`], repoPath);
  const ab = counts.code === 0 ? parseAheadBehind(counts.stdout) : null;
  return ab ? { upstream, ...ab, fetched } : null;
}
