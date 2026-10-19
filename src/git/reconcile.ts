/**
 * Orphaned-worktree detection (M3).
 *
 * The bar here is different from the rest of the module: a false positive
 * invites the user to delete real work. So the classifier is deliberately
 * conservative and splits its findings in two:
 *
 *   `orphan`  - we are confident this is an Albedo-created worktree that no
 *               task row claims, or a directory under ~/agents whose `.git`
 *               file points at a gitdir that no longer exists.
 *   `unknown` - a worktree git knows about that no task claims, but which lives
 *               outside ~/agents (the user's own ~/www/worktrees, for example).
 *               The UI treats these as informational and offers no remove.
 *
 * Everything that makes a decision is a pure function so it can be unit-tested;
 * the async entry point only gathers the inputs.
 */

import {
  basename,
  git,
  listWorktreesDetailed,
  type ParsedWorktree,
  type WorktreeInfo,
} from './worktree';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrphanClassification = 'orphan' | 'unknown';

/**
 * Structurally a {@link WorktreeInfo} (so the frozen `findOrphans` signature
 * holds) plus the provenance the UI needs to decide what it is allowed to do.
 */
export interface OrphanInfo extends WorktreeInfo {
  classification: OrphanClassification;
  /** Human sentence explaining why this row is here. Shown in the UI. */
  reason: string;
  /** Repo this worktree belongs to, when we know it. */
  repoPath: string | null;
  /** `git` = reported by `git worktree list`; `disk` = found by scanning. */
  source: 'git' | 'disk';
  prunable: boolean;
  bare: boolean;
  detached: boolean;
}

/** One repo's `git worktree list --porcelain`, already parsed. */
export interface RepoScan {
  repoPath: string;
  /** git lists the main worktree first; we skip it. */
  worktrees: ParsedWorktree[];
}

/** A directory under `~/agents/<repo>/<slug>` that we probed on disk. */
export interface DiskCandidate {
  path: string;
  /** True when the entry has a `.git` *file* (a worktree), not a directory. */
  hasGitFile: boolean;
  /** Absolute gitdir the `.git` file points at, if it parsed. */
  gitdirTarget: string | null;
  /** Whether that gitdir still exists. */
  gitdirExists: boolean;
}

// ---------------------------------------------------------------------------
// Pure path normalisation
// ---------------------------------------------------------------------------

/**
 * macOS firmlinks. `/tmp`, `/var` and `/etc` are symlinks into `/private`, and
 * git reports the resolved form while a user (or a test fixture) usually types
 * the short one. Comparing without this produces phantom orphans.
 */
const FIRMLINKS: ReadonlyArray<readonly [string, string]> = [
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var'],
  ['/etc', '/private/etc'],
];

/** Expand a leading `~` (and `~/`) against a home directory. */
export function expandTilde(p: string, home: string): string {
  if (p === '~') return home.replace(/\/+$/, '');
  if (p.startsWith('~/')) {
    return `${home.replace(/\/+$/, '')}/${p.slice(2)}`;
  }
  return p;
}

/**
 * Textual canonicalisation: collapse duplicate slashes, drop `.` segments,
 * resolve `..` segments, strip a trailing slash, and apply the macOS firmlinks.
 * Case is preserved -- see {@link pathKey} for the comparison form.
 */
export function normalizePath(p: string): string {
  let s = (p ?? '').trim();
  if (s.length === 0) return '';
  const absolute = s.startsWith('/');
  const parts: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!absolute) parts.push('..');
      continue;
    }
    parts.push(seg);
  }
  s = (absolute ? '/' : '') + parts.join('/');
  if (s.length > 1) s = s.replace(/\/+$/, '');

  for (const [short, real] of FIRMLINKS) {
    if (s === short) return real;
    if (s.startsWith(`${short}/`)) return real + s.slice(short.length);
  }
  return s;
}

/**
 * Comparison key. macOS's default volume is case-insensitive, so
 * `/Users/x/agents/Repo/slug` and `/users/x/agents/repo/slug` are the same
 * directory and must not be reported as two different worktrees.
 */
export function pathKey(p: string): string {
  return normalizePath(p).toLowerCase();
}

/** The first root in `roots` that contains `path`, or null. */
export function rootContaining(roots: string[], path: string): string | null {
  for (const r of roots) {
    if (r && isUnder(r, path)) return r;
  }
  return null;
}

/** True when `path` sits under any known project worktree root. */
export function isUnderAnyRoot(roots: string[], path: string): boolean {
  return rootContaining(roots, path) !== null;
}

/** True when `child` is `parent` itself or lives beneath it. */
export function isUnder(parent: string, child: string): boolean {
  const a = pathKey(parent);
  const b = pathKey(child);
  if (a === b) return true;
  return b.startsWith(a.endsWith('/') ? a : `${a}/`);
}

/** Resolve a possibly-relative path against a base directory. */
export function resolveAgainst(base: string, rel: string): string {
  if (rel.startsWith('/')) return normalizePath(rel);
  return normalizePath(`${base}/${rel}`);
}

/**
 * Parse a worktree's `.git` file, which is a single line:
 *   `gitdir: /path/to/repo/.git/worktrees/<name>`
 * Returns null for anything else (including a `.git` directory's contents).
 */
export function parseDotGitFile(text: string): string | null {
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('gitdir:')) continue;
    const target = line.slice('gitdir:'.length).trim();
    return target.length > 0 ? target : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ownership: which directories Albedo is allowed to touch
//
// Albedo cuts a worktree for a task it creates, so removing it on archive is
// safe -- it made it. A RESUMED session runs in whatever cwd it originally
// used, frequently the user's main checkout. Removing that would be
// catastrophic, and would look entirely reasonable on the way past, because
// nothing else in the archive flow can tell the two apart.
//
// git itself refuses to remove a *main* working tree, even with --force, which
// is a real floor under the worst case. It is happy to remove a hand-made
// LINKED worktree though -- and that is exactly the layout this user has
// (~/www/acme-worktree/...). So for linked worktrees the flag is the only
// thing standing between a resumed session and a deleted directory.
// ---------------------------------------------------------------------------

/** As much of a task as the ownership rules need. */
export interface OwnershipFacts {
  status?: string;
  worktreePath: string;
  /**
   * False when the directory was not created by Albedo. Optional only so this
   * module does not have to wait on the column reaching `Task`; the database
   * column is NOT NULL DEFAULT 1, so absent means owned, exactly as it does
   * for every row that predates the flag.
   */
  ownsWorktree?: boolean;
}

/** True when Albedo created this directory and may therefore remove it. */
export function albedoOwnsWorktree(task: OwnershipFacts): boolean {
  return task.ownsWorktree !== false;
}

/**
 * Worktree paths of archived tasks that Albedo may offer to reclaim.
 *
 * Pure and exported rather than inline in the reconcile view, because "may we
 * delete this?" is the single most consequential predicate in this module and
 * it belongs somewhere it can be tested. An archived *resumed* task is archived
 * like any other, but its directory is the user's own and must never appear as
 * an orphan with a remove button next to it.
 */
export function reclaimableTaskPaths(tasks: OwnershipFacts[]): string[] {
  // A directory can outlive the task that made it: resuming that task's session
  // (or reusing its slug) starts a live task in the same cwd. Being archived
  // does not make a path reclaimable while anything live still runs there.
  const live = new Set(
    tasks.filter((t) => t.status !== 'archived' && t.worktreePath).map((t) => pathKey(t.worktreePath)),
  );
  return tasks
    .filter((t) => t.status === 'archived')
    .filter(albedoOwnsWorktree)
    .map((t) => t.worktreePath)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .filter((p) => !live.has(pathKey(p)));
}

/**
 * True when another non-archived task runs in `task`'s directory. Removing the
 * worktree would pull it out from under that session, so the archive dialog
 * treats a shared directory exactly like one Albedo does not own.
 */
export function worktreeSharedWithLiveTask(
  task: OwnershipFacts & { id: number },
  others: readonly (OwnershipFacts & { id: number })[],
): boolean {
  if (!task.worktreePath) return false;
  const key = pathKey(task.worktreePath);
  return others.some(
    (t) => t.id !== task.id && t.status !== 'archived' && !!t.worktreePath && pathKey(t.worktreePath) === key,
  );
}

// ---------------------------------------------------------------------------
// Worktree-root validation
//
// `worktreeRoot` is typed or picked by the user, and a bad one does not fail
// until a task is created -- i.e. at the worst possible moment, after the user
// has named the work and committed to starting it. So it is validated on save,
// and every rejection names its reason.
// ---------------------------------------------------------------------------

export type WorktreeRootCheck =
  | { ok: true; path: string; warning: string | null }
  | { ok: false; reason: string };

/**
 * The rules that can be decided without touching the filesystem.
 *
 * Returns the expanded, normalised absolute path on success so the caller
 * stores the resolved form rather than whatever was typed.
 */
export function validateWorktreeRoot(
  root: string,
  opts: { repoPath: string; home: string },
): WorktreeRootCheck {
  const raw = (root ?? '').trim();
  if (raw.length === 0) return { ok: false, reason: 'Choose a directory for this project’s worktrees.' };

  const expanded = expandTilde(raw, opts.home);
  if (!expanded.startsWith('/')) {
    return {
      ok: false,
      reason: `${raw} is not an absolute path. Use a full path, or one starting with ~/.`,
    };
  }

  const path = normalizePath(expanded);
  const home = normalizePath(opts.home);
  const segments = path.split('/').filter(Boolean);

  if (segments.length === 0) {
    return { ok: false, reason: 'The filesystem root / cannot hold worktrees.' };
  }
  if (path === home) {
    return { ok: false, reason: 'That is your home directory itself. Choose a folder inside it.' };
  }
  if (segments.length < 2) {
    return { ok: false, reason: `${path} is too close to the filesystem root. Choose a folder inside it.` };
  }
  // `/Users/someone-else` -- same depth and same parent as home, so it is a
  // home directory even though it is not *this* user's.
  const homeSegments = home.split('/').filter(Boolean);
  if (
    homeSegments.length >= 2 &&
    segments.length === homeSegments.length &&
    parentOf(path) === parentOf(home)
  ) {
    return { ok: false, reason: `${path} looks like a home directory. Choose a folder inside it.` };
  }

  // The one that actually bites: git will happily create a worktree inside the
  // repository it came from, and then the repo contains a checkout of itself.
  const repo = normalizePath(expandTilde((opts.repoPath ?? '').trim(), opts.home));
  if (repo && isUnder(repo, path)) {
    return {
      ok: false,
      reason:
        path === repo
          ? 'That is the project repository itself. A worktree cannot live inside the repo it came from.'
          : `${path} is inside the project repository (${repo}). A worktree inside its own repo confuses git and every tool that reads it.`,
    };
  }

  // Not fatal, but worth saying out loud.
  const warning =
    repo && isUnder(path, repo)
      ? `${path} contains the repository itself. That works, but worktrees will sit next to it.`
      : null;

  return { ok: true, path, warning };
}

/** Pure path parent; `/a/b` -> `/a`, `/a` -> `/`. */
function parentOf(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '/';
  return p.slice(0, idx);
}

/**
 * {@link validateWorktreeRoot} plus the one rule that needs the filesystem:
 * the parent must exist. The root itself is created on demand by
 * `git worktree add`, so it is allowed to be missing.
 */
export async function checkWorktreeRoot(
  root: string,
  opts: { repoPath: string; home: string },
): Promise<WorktreeRootCheck> {
  const pure = validateWorktreeRoot(root, opts);
  if (!pure.ok) return pure;

  const parent = parentOf(pure.path);
  try {
    const fs = await import('@tauri-apps/plugin-fs');
    if (!(await fs.exists(parent))) {
      return {
        ok: false,
        reason: `${parent} does not exist. Create it first, or choose somewhere else — only the last folder is created for you.`,
      };
    }
  } catch {
    // Cannot read the filesystem (permissions, scope). Do not block the user on
    // a check we were unable to perform; the pure rules already passed.
    return { ...pure, warning: pure.warning };
  }
  return pure;
}

// ---------------------------------------------------------------------------
// Pure classifier
// ---------------------------------------------------------------------------

export interface ClassifyInput {
  scans: RepoScan[];
  disk: DiskCandidate[];
  /**
   * Every known project's `worktreeRoot`, `~` already expanded. A worktree
   * under one of these is something Albedo has a claim on; anything outside
   * all of them is `unknown` and gets no remove button. Replaces the hardcoded
   * `~/agents`, which is what made the user's own ~/www/worktrees unreachable.
   */
  worktreeRoots: string[];
  knownPaths: string[];
  /**
   * Paths that a task row still references but which are nonetheless available
   * to reclaim -- in practice, the worktrees of archived tasks.
   *
   * Without this the archive path has a hole: `archiveTask` only flips a status,
   * so the row survives, so its `worktreePath` stays in `knownPaths`, so the
   * worktree is hidden from reconcile forever while still sitting on disk.
   * Listed here it wins over `knownPaths` and is reported as an orphan.
   */
  reclaimablePaths?: string[];
  home: string;
}

/**
 * Decide which worktrees are orphaned. Pure: every input has already been
 * gathered, so this is fully unit-testable without git or a filesystem.
 */
export function classifyOrphans(input: ClassifyInput): OrphanInfo[] {
  const home = input.home;
  const roots = input.worktreeRoots.map((r) => expandTilde(r, home)).filter((r) => r.length > 0);

  const reclaimable = new Set<string>();
  for (const k of input.reclaimablePaths ?? []) {
    if (!k) continue;
    reclaimable.add(pathKey(expandTilde(k, home)));
  }

  const known = new Set<string>();
  for (const k of input.knownPaths) {
    if (!k) continue;
    const key = pathKey(expandTilde(k, home));
    // Reclaimable wins: an archived task's worktree is "known" to the database
    // and still reclaimable on disk, and hiding it is the bug this closes.
    if (!reclaimable.has(key)) known.add(key);
  }

  const out: OrphanInfo[] = [];
  const emitted = new Set<string>();

  for (const scan of input.scans) {
    const repoKey = pathKey(scan.repoPath);
    for (const [idx, wt] of scan.worktrees.entries()) {
      // The main worktree is always first in the porcelain output and is the
      // repo itself. Never a candidate for removal.
      if (idx === 0) continue;
      if (wt.bare) continue;
      const key = pathKey(wt.path);
      if (key === repoKey) continue;
      if (known.has(key)) continue;
      if (emitted.has(key)) continue;

      const insideAgents = isUnderAnyRoot(roots, wt.path);
      const isReclaimable = reclaimable.has(key);
      // An archived task's worktree is reclaimable wherever it lives: the user
      // told us they are done with it, so it is not a guess on our part.
      const classification: OrphanClassification =
        insideAgents || isReclaimable ? 'orphan' : 'unknown';
      const reason = isReclaimable
        ? 'Its task is archived, but the worktree is still on disk.'
        : wt.prunable
          ? `git reports this worktree as prunable${wt.prunableReason ? `: ${wt.prunableReason}` : ''}`
          : insideAgents
            ? `Under ${rootContaining(roots, wt.path) ?? 'a project worktree root'} but no task references it.`
            : `Tracked by ${basename(scan.repoPath)} but outside every project worktree root.`;

      emitted.add(key);
      out.push({
        path: wt.path,
        branch: wt.branch,
        head: wt.head,
        locked: wt.locked,
        classification,
        reason,
        repoPath: scan.repoPath,
        source: 'git',
        prunable: wt.prunable,
        bare: wt.bare,
        detached: wt.detached,
      });
    }
  }

  for (const cand of input.disk) {
    const key = pathKey(cand.path);
    if (known.has(key)) continue;
    if (emitted.has(key)) continue;
    // Only ever consider directories under a known project root: the scan must
    // not wander anywhere the user has not pointed a project at.
    if (!isUnderAnyRoot(roots, cand.path)) continue;
    // A directory with no `.git` file is not a worktree. Saying nothing is the
    // conservative answer -- we do not offer to delete arbitrary directories.
    if (!cand.hasGitFile) continue;

    emitted.add(key);
    if (!cand.gitdirExists) {
      out.push({
        path: cand.path,
        branch: null,
        head: '',
        locked: false,
        classification: 'orphan',
        reason: cand.gitdirTarget
          ? `Stale worktree: its .git points at ${cand.gitdirTarget}, which no longer exists.`
          : 'Stale worktree: its .git file could not be resolved to a gitdir.',
        repoPath: null,
        source: 'disk',
        prunable: true,
        bare: false,
        detached: false,
      });
    } else {
      out.push({
        path: cand.path,
        branch: null,
        head: '',
        locked: false,
        classification: 'unknown',
        reason:
          'A worktree of a repository that is not in the scan list. ' +
          'Open that repo in Albedo to manage it.',
        repoPath: gitdirToRepoPath(cand.gitdirTarget),
        source: 'disk',
        prunable: false,
        bare: false,
        detached: false,
      });
    }
  }

  out.sort((a, b) => {
    if (a.classification !== b.classification) return a.classification === 'orphan' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return out;
}

/**
 * `/repo/.git/worktrees/slug` -> `/repo`. Returns null when the shape does not
 * match, rather than guessing.
 */
export function gitdirToRepoPath(gitdir: string | null): string | null {
  if (!gitdir) return null;
  const norm = normalizePath(gitdir);
  const marker = '/.git/worktrees/';
  const idx = norm.indexOf(marker);
  if (idx <= 0) return null;
  return norm.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Async entry point
// ---------------------------------------------------------------------------

/** Everything {@link findOrphans} needs. An object because there are now four
 * lists and positional arguments had stopped being readable. */
export interface FindOrphansOptions {
  /** Repos to interrogate with `git worktree list` -- every project's repoPath. */
  repoPaths: string[];
  /**
   * Every project's `worktreeRoot` (a leading `~` is expanded here). A worktree
   * under one of these is Albedo's business; anything outside them all is
   * reported as `unknown` with no remove button. This is what turns the user's
   * pre-existing ~/www/worktrees entries into actionable rows the moment a
   * project points there -- and what stops us offering to delete anything else.
   */
  worktreeRoots: string[];
  /**
   * `worktree_path` of task rows that still own their worktree. Pass every
   * task, archived ones included, so nothing in use is misreported.
   */
  knownPaths: string[];
  /**
   * Rows that exist but have given up their worktree: the worktree paths of
   * **archived** tasks. Overrides `knownPaths`, so the worktree is reported as
   * an orphan and can be removed. Without it an archived task's worktree is
   * unreachable from the UI -- the row keeps the path "known" forever while the
   * directory sits on disk.
   */
  reclaimablePaths?: string[];
}

/**
 * Worktrees on disk that no live task claims.
 *
 * Failures to read one repo or one directory are swallowed on purpose: a repo
 * that has been moved away should not blank the whole reconcile view, and it
 * must never cause a worktree to be *misreported* as orphaned.
 */
export async function findOrphans(o: FindOrphansOptions): Promise<OrphanInfo[]> {
  const { homeDir } = await import('@tauri-apps/api/path');
  const home = await homeDir();

  const scans: RepoScan[] = [];
  for (const repoPath of dedupePaths(o.repoPaths)) {
    try {
      scans.push({ repoPath, worktrees: await listWorktreesDetailed(repoPath) });
    } catch {
      // Repo unreadable/moved: contribute nothing rather than a wrong answer.
    }
  }

  const [resolvedKnown, resolvedReclaimable] = await Promise.all([
    resolveKnownPaths(o.knownPaths, home),
    resolveKnownPaths(o.reclaimablePaths ?? [], home),
  ]);

  const roots = dedupePaths(o.worktreeRoots.map((r) => expandTilde(r, home)));
  const disk: DiskCandidate[] = [];
  for (const root of roots) {
    disk.push(...(await scanWorktreeRoot(root)));
  }

  return classifyOrphans({
    scans,
    disk,
    worktreeRoots: roots,
    knownPaths: resolvedKnown,
    reclaimablePaths: resolvedReclaimable,
    home,
  });
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const k = pathKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/**
 * Best-effort symlink resolution for the task-owned paths. `git rev-parse
 * --show-toplevel` inside a worktree returns the path with symlinks resolved,
 * which is exactly the form `git worktree list` prints -- so resolving here is
 * what makes the two sides comparable when the user's home or repo root is a
 * symlink. Both the raw and resolved forms are kept: more known paths can only
 * ever suppress an orphan, never create one.
 */
async function resolveKnownPaths(knownPaths: string[], home: string): Promise<string[]> {
  const out: string[] = [];
  for (const raw of knownPaths) {
    if (!raw) continue;
    const expanded = expandTilde(raw, home);
    out.push(expanded);
    try {
      const r = await git(['rev-parse', '--show-toplevel'], expanded);
      if (r.code === 0) {
        const top = r.stdout.trim();
        if (top) out.push(top);
      }
    } catch {
      // Path gone or not a worktree; the textual form still counts as known.
    }
  }
  return out;
}

/**
 * Walk one project worktree root and probe anything that looks like a worktree.
 *
 * Two levels deep, not one: the documented layout is `<root>/<slug>`, but the
 * pre-projects layout was `~/agents/<repo>/<slug>` and a user who nests by repo
 * under their own root is doing something reasonable. Depth 2 covers both, and
 * costs nothing in correctness because only directories carrying a `.git`
 * *file* are ever reported.
 */
async function scanWorktreeRoot(root: string): Promise<DiskCandidate[]> {
  const fs = await import('@tauri-apps/plugin-fs');
  const candidates: DiskCandidate[] = [];

  /** Probe one directory. Returns null when it is not a worktree at all. */
  const probe = async (path: string): Promise<DiskCandidate | null> => {
    const dotGit = `${path}/.git`;
    let text: string;
    try {
      const info = await fs.stat(dotGit);
      if (info.isDirectory) return null; // a real clone, not a worktree
      text = await fs.readTextFile(dotGit);
    } catch {
      return null; // no .git, or unreadable: not a candidate
    }
    const target = parseDotGitFile(text);
    const absTarget = target ? resolveAgainst(path, target) : null;
    let gitdirExists = false;
    if (absTarget) {
      try {
        gitdirExists = await fs.exists(absTarget);
      } catch {
        gitdirExists = false;
      }
    }
    return { path, hasGitFile: true, gitdirTarget: absTarget, gitdirExists };
  };

  let top: Array<{ name: string; isDirectory: boolean }> = [];
  try {
    top = await fs.readDir(root);
  } catch {
    return candidates; // the root does not exist yet: nothing to reconcile
  }

  for (const entry of top) {
    if (!entry.isDirectory) continue;
    const path = `${root}/${entry.name}`;

    const direct = await probe(path);
    if (direct) {
      candidates.push(direct);
      continue; // a worktree does not contain more worktrees
    }

    // Not a worktree itself -- look one level deeper for the nested layout.
    let leaves: Array<{ name: string; isDirectory: boolean }> = [];
    try {
      leaves = await fs.readDir(path);
    } catch {
      continue;
    }
    for (const leaf of leaves) {
      if (!leaf.isDirectory) continue;
      const nested = await probe(`${path}/${leaf.name}`);
      if (nested) candidates.push(nested);
    }
  }
  return candidates;
}

