/**
 * Runtime filesystem scope grants for project directories.
 *
 * `src-tauri/capabilities/default.json` statically grants `~/.claude/projects`
 * (transcripts) and `~/agents` (the worktree root that used to be hardcoded).
 * But a project chooses where its worktrees live -- that is the whole point of
 * the feature -- so a project pointed at `~/www/acme-worktree` puts every
 * file in it outside the static scope, and opening one fails with
 * "forbidden path: ... not allowed on the scope for allow-read-text-file".
 *
 * The set of directories to allow is therefore not knowable until the user has
 * told us where their projects are, which is what the runtime grant is for.
 * Widening the static scope to `$HOME/**` would have worked and is the wrong
 * trade: granting a whole home directory to reach one worktree.
 *
 * THIS IS NOT A CONTAINMENT CHECK. `resolveInWorktree` in src/lib/paths.ts
 * remains the single boundary deciding whether a path the transcript mentions
 * may be opened. A grant here only makes the plugin willing to read a directory
 * the user themselves chose with a directory picker; it says nothing about which
 * paths inside it are legitimate.
 */

import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';

/** Paths already granted this run, so repeated calls cost nothing. */
const granted = new Set<string>();

/** Test hook: forget what has been granted. */
export function resetGrants(): void {
  granted.clear();
}

/**
 * Expand a leading `~`.
 *
 * NOT cosmetic: the pre-projects backfill stores `~/agents/<repo>` as a
 * project's worktreeRoot, and the Rust command refuses relative paths. On the
 * user's live database one of two projects has exactly that value, so without
 * this it reports a failure for a perfectly valid root.
 */
function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home}${path.slice(1)}`;
  return path;
}

/**
 * Does this failure just mean "the directory is not there yet"?
 *
 * A project's worktreeRoot is created on demand, so a configured root that has
 * not been used yet is the normal state rather than a fault. The Rust side
 * canonicalises before granting, so a missing directory comes back as an io
 * error. On the user's live database two of five directories are in this
 * state, so treating it as an error would put a banner over two healthy
 * projects on every launch.
 *
 * Matching on the message is not lovely -- a structured signal from
 * `allow_project_dir` would be better. Deliberately narrow: anything
 * unrecognised is still reported.
 */
function isNotYetPresent(message: string): boolean {
  return /no such file or directory/i.test(message);
}

/**
 * Grant one directory. Idempotent within a run and on the Rust side.
 * Resolves to the error string rather than throwing, so a caller granting many
 * directories can report the failures without losing the successes.
 */
export async function grantDir(
  path: string | null | undefined,
  home = '',
): Promise<string | null> {
  const raw = path?.trim();
  if (!raw) return null;
  const dir = expandHome(raw, home).replace(/\/+$/, '');
  if (!dir || granted.has(dir)) return null;
  try {
    await invoke('allow_project_dir', { path: dir });
    granted.add(dir);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Not memoised either way: a directory created later must be granted then,
    // and a transient failure deserves a retry on the next call.
    if (isNotYetPresent(message)) return null;
    return `${dir}: ${message}`;
  }
}

export interface GrantTargets {
  /** Project repository roots. */
  repoPaths?: (string | null | undefined)[];
  /** Project worktree roots -- where a project's worktrees are created. */
  worktreeRoots?: (string | null | undefined)[];
  /** Individual task worktrees, which can sit outside their project's root. */
  worktreePaths?: (string | null | undefined)[];
}

/**
 * Grant every directory the app may need to read files from.
 *
 * Failures are collected rather than thrown: one unreadable project must not
 * stop the others being granted, and the caller surfaces them. A silent failure
 * here means files in that project simply will not open, which is exactly the
 * kind of quiet degradation this project has been bitten by before.
 */
export async function grantProjectDirs(t: GrantTargets): Promise<string[]> {
  let home = '';
  try {
    home = (await homeDir()).replace(/\/+$/, '');
  } catch {
    // Without a home directory a `~` path cannot be expanded. Absolute paths
    // still work, so carry on rather than granting nothing.
  }
  const all = [...(t.repoPaths ?? []), ...(t.worktreeRoots ?? []), ...(t.worktreePaths ?? [])];
  // Sequential: the grants share a memo, and concurrent calls for the same
  // directory would each miss it and invoke twice.
  const denied: string[] = [];
  for (const path of all) {
    const err = await grantDir(path, home);
    if (err !== null) denied.push(err);
  }
  return denied;
}
