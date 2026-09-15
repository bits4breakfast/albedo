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
export type GitRunner = (args: string[], cwd?: string) => Promise<GitResult>;

let runner: GitRunner = async (args, cwd) => {
  // Lazy import: keeps `@tauri-apps/plugin-shell` out of the module graph for
  // the pure-parser unit tests, which run in plain node.
  const { Command } = await import('@tauri-apps/plugin-shell');
  const child = await Command.create('git', args, cwd ? { cwd } : undefined).execute();
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

/** Test seam. Returns the previous probe so a test can restore it. */
export function setPathExistsProbe(next: PathExistsProbe): PathExistsProbe {
  const prev = pathExists;
  pathExists = next;
  return prev;
}

/** Run git and return the raw result without throwing. */
export async function git(args: string[], cwd?: string): Promise<GitResult> {
  assertSafeArgv(args);
  return runner(args, cwd);
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

/** Absolute toplevel of the repo containing `repoPath`, symlinks resolved. */
export async function repoToplevel(repoPath: string): Promise<string> {
  const out = await gitOk(['rev-parse', '--show-toplevel'], repoPath);
  const top = out.trim();
  if (!top) {
    throw new Error(`Could not determine the git toplevel for ${repoPath}`);
  }
  return top;
}

/** Basename of the repo's toplevel, e.g. `/Users/x/www/albedo` -> `albedo`. */
export async function repoName(repoPath: string): Promise<string> {
  const top = await repoToplevel(repoPath);
  return basename(top);
}

/** Pure basename, so `repoName` has no Tauri dependency beyond the git call. */
export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Local branches plus remote-tracking branches (so a task can be based off
 * `origin/main` without fetching first), and the currently checked-out branch.
 *
 * On a detached HEAD, `current` is the short commit id and is NOT included in
 * `all` -- the dialog shows it as a hint but the user must pick a real base.
 */
export async function listBranches(repoPath: string): Promise<{ current: string; all: string[] }> {
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

  const seen = new Set<string>();
  const all: string[] = [];
  for (const b of [...locals, ...remotes]) {
    if (!seen.has(b)) {
      seen.add(b);
      all.push(b);
    }
  }
  return { current, all };
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
}

/**
 * `git worktree add -b <branch> <path> <baseBranch>` (or, with
 * `useExistingBranch`, `git worktree add <path> <branch>`).
 *
 * Uncommitted changes in the origin repo are fine and are deliberately not
 * checked: a worktree is an independent checkout.
 */
export async function createWorktree(o: CreateWorktreeOptions): Promise<void> {
  assertValidRefName(o.branch, 'branch');
  assertNotOptionLike(o.path, 'worktree path');
  if (!o.useExistingBranch) {
    assertValidRefName(o.baseBranch, 'base branch');
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
    : ['worktree', 'add', '-b', o.branch, '--', o.path, o.baseBranch];

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
 */
export async function removeWorktree(o: RemoveWorktreeOptions): Promise<void> {
  assertNotOptionLike(o.path, 'worktree path');
  if (o.branch !== null) assertValidRefName(o.branch, 'branch');

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

/** Re-exported from ./reconcile so the frozen module surface stays in one file. */
export { findOrphans } from './reconcile';
export type { OrphanInfo } from './reconcile';

/** Re-exported for callers that want to validate a hand-typed base branch. */
export { isValidRefName };
