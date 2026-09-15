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
  agentsRoot,
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
// Pure classifier
// ---------------------------------------------------------------------------

export interface ClassifyInput {
  scans: RepoScan[];
  disk: DiskCandidate[];
  knownPaths: string[];
  home: string;
}

/**
 * Decide which worktrees are orphaned. Pure: every input has already been
 * gathered, so this is fully unit-testable without git or a filesystem.
 */
export function classifyOrphans(input: ClassifyInput): OrphanInfo[] {
  const home = input.home;
  const root = agentsRoot(home);

  const known = new Set<string>();
  for (const k of input.knownPaths) {
    if (!k) continue;
    known.add(pathKey(expandTilde(k, home)));
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

      const insideAgents = isUnder(root, wt.path);
      const classification: OrphanClassification = insideAgents ? 'orphan' : 'unknown';
      const reason = wt.prunable
        ? `git reports this worktree as prunable${wt.prunableReason ? `: ${wt.prunableReason}` : ''}`
        : insideAgents
          ? `Created under ${root} but no task references it.`
          : `Tracked by ${basename(scan.repoPath)} but outside ${root} and unknown to Albedo.`;

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
    // Only ever consider directories under ~/agents: this scan must not wander
    // into the user's own worktree roots.
    if (!isUnder(root, cand.path)) continue;
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

/**
 * Worktrees on disk that no task row claims.
 *
 * `repoPaths` are the repos to interrogate with `git worktree list`;
 * `knownPaths` are the `worktree_path` values of every task row (including
 * archived ones -- passing only live tasks would report archived worktrees as
 * orphans).
 *
 * Failures to read one repo or one directory are swallowed on purpose: a repo
 * that has been moved away should not blank the whole reconcile view, and it
 * must never cause a worktree to be *misreported* as orphaned.
 */
export async function findOrphans(
  repoPaths: string[],
  knownPaths: string[],
): Promise<OrphanInfo[]> {
  const { homeDir } = await import('@tauri-apps/api/path');
  const home = await homeDir();

  const scans: RepoScan[] = [];
  for (const repoPath of dedupePaths(repoPaths)) {
    try {
      scans.push({ repoPath, worktrees: await listWorktreesDetailed(repoPath) });
    } catch {
      // Repo unreadable/moved: contribute nothing rather than a wrong answer.
    }
  }

  const resolvedKnown = await resolveKnownPaths(knownPaths, home);
  const disk = await scanAgentsRoot(agentsRoot(home));

  return classifyOrphans({ scans, disk, knownPaths: resolvedKnown, home });
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

/** Walk `~/agents/<repo>/<slug>` two levels deep and probe each leaf. */
async function scanAgentsRoot(root: string): Promise<DiskCandidate[]> {
  const fs = await import('@tauri-apps/plugin-fs');
  const candidates: DiskCandidate[] = [];

  let repoDirs: Array<{ name: string; isDirectory: boolean }> = [];
  try {
    repoDirs = await fs.readDir(root);
  } catch {
    return candidates; // ~/agents does not exist yet: nothing to reconcile.
  }

  for (const repoDir of repoDirs) {
    if (!repoDir.isDirectory) continue;
    const repoDirPath = `${root}/${repoDir.name}`;
    let leaves: Array<{ name: string; isDirectory: boolean }> = [];
    try {
      leaves = await fs.readDir(repoDirPath);
    } catch {
      continue;
    }
    for (const leaf of leaves) {
      if (!leaf.isDirectory) continue;
      const path = `${repoDirPath}/${leaf.name}`;
      const dotGit = `${path}/.git`;

      let text: string | null = null;
      try {
        const info = await fs.stat(dotGit);
        if (info.isDirectory) continue; // a real clone, not a worktree
        text = await fs.readTextFile(dotGit);
      } catch {
        // No .git at all, or unreadable: not a worktree, so not a candidate.
        continue;
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
      candidates.push({ path, hasGitFile: true, gitdirTarget: absTarget, gitdirExists });
    }
  }
  return candidates;
}
