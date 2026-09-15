/**
 * Runtime filesystem scope grants for project directories.
 *
 * `src-tauri/capabilities/default.json` statically grants `~/.claude/projects`
 * (transcripts) and `~/agents` (the worktree root that used to be hardcoded).
 * But a project chooses where its worktrees live -- that is the whole point of
 * the feature -- so a project pointed at `~/www/upsellguru-worktree` puts every
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

/** Paths already granted this run, so repeated calls cost nothing. */
const granted = new Set<string>();

/**
 * Grant one directory. Idempotent within a run and on the Rust side.
 * Resolves to the error string rather than throwing, so a caller granting many
 * directories can report the failures without losing the successes.
 */
export async function grantDir(path: string | null | undefined): Promise<string | null> {
  const dir = path?.trim();
  if (!dir || granted.has(dir)) return null;
  try {
    await invoke('allow_project_dir', { path: dir });
    granted.add(dir);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
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
  const all = [...(t.repoPaths ?? []), ...(t.worktreeRoots ?? []), ...(t.worktreePaths ?? [])];
  const results = await Promise.all(all.map(grantDir));
  return results.filter((r): r is string => r !== null);
}
