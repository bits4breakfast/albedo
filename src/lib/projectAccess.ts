/**
 * src/lib/projectAccess.ts
 *
 * Tells the fs plugin it is allowed to read the directories the user chose.
 *
 * The static scope in `capabilities/default.json` covers `~/.claude/projects`
 * and `~/agents`. But a project chooses where its worktrees live -- that is the
 * whole point of the feature -- so a project at `/Users/x/www/upsellguru-UP-2368`
 * sits outside the static scope and every file in it fails to open with
 * "forbidden path". This grants those directories at runtime, via the
 * `allow_project_dir` command.
 *
 * ### WHAT THIS IS NOT
 *
 * Not a containment check. `resolveInWorktree` in src/lib/paths.ts remains the
 * single boundary deciding whether a path a transcript mentions may be opened.
 * A successful grant here means "the plugin will read this directory", NOT
 * "anything under it is safe to open". A caller that treats it as the latter
 * has removed the only check that matters, because transcripts contain paths
 * the model wrote, not paths the user chose.
 *
 * ### Why this is not in src/db
 *
 * `backfillProjectsFromTasks` already runs at startup with these rows in hand,
 * which is tempting. But the data layer does not touch the filesystem -- the
 * same rule that keeps `cwdExists` null in sessions.ts and keeps `repoRootFor`
 * injected rather than imported. Which paths exist is a data question; whether
 * this process may read them is not. So this takes already-loaded rows as
 * arguments and the shell calls it.
 */

import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';

import { expandTilde } from '../git/reconcile';
import type { Project, Task } from '../types';

/** Directories granted successfully in this process. Failures are retried. */
const granted = new Set<string>();

export interface GrantFailure {
  path: string;
  error: string;
}

export interface GrantReport {
  /** Newly granted in this call. */
  granted: string[];
  failed: GrantFailure[];
  /** Already granted earlier in this process, so not re-sent. */
  skipped: number;
  /**
   * Directories that do not exist YET. Not a failure and not reported to the
   * user: a project's `worktreeRoot` is created on demand, so a configured
   * root that has not been used yet is the normal state, not a fault.
   *
   * Checked against the user's real rows: two of their five directories are in
   * exactly this state, so without this distinction the first launch after
   * this lands would show an error banner about two perfectly healthy
   * projects.
   */
  pending: string[];
}

/**
 * Does this grant failure just mean "the directory is not there yet"?
 *
 * The Rust side canonicalises before granting, so a missing directory comes
 * back as an io error. Matching on the message is not lovely; a structured
 * signal from `allow_project_dir` (returning Ok for a not-yet-present path, or
 * a typed error) would be better and has been raised with the lead. Until
 * then this is deliberately narrow: anything it does not recognise is treated
 * as a real failure and surfaced.
 */
function isNotYetPresent(message: string): boolean {
  return /no such file or directory/i.test(message);
}

/** Test/teardown hook: forget what has been granted. */
export function resetProjectAccess(): void {
  granted.clear();
}

function normalise(raw: string, home: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const expanded = expandTilde(trimmed, home).replace(/\/+$/, '');
  // The Rust side refuses relative paths; catching it here keeps a stored
  // `~/agents/...` (the pre-projects default) from looking like a failure.
  if (!expanded.startsWith('/')) return null;
  return expanded;
}

/**
 * Every directory that must be readable for projects and tasks to work.
 *
 * Three sources, and all three are needed:
 *  - `project.repoPath`     — the repository itself, for reading tracked files
 *  - `project.worktreeRoot` — where its worktrees are created
 *  - `task.worktreePath`    — a task can predate its project, or sit outside
 *                             its project's root entirely
 *
 * Pure, so the set can be asserted without a Tauri host.
 */
export function projectAccessPaths(
  projects: Project[],
  tasks: Task[],
  home: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined) => {
    if (typeof raw !== 'string') return;
    const path = normalise(raw, home);
    if (path === null || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };

  for (const p of projects) {
    add(p.repoPath);
    add(p.worktreeRoot);
  }
  for (const t of tasks) add(t.worktreePath);
  return out;
}

/**
 * Grant access to every directory these projects and tasks need.
 *
 * Idempotent on both sides: the Rust command tolerates repeats, and successes
 * are remembered here so a re-run after `onProjectsChanged` costs nothing.
 *
 * Failures are collected, never thrown. One unreadable directory must not stop
 * the others being granted -- but it does mean files in that project will not
 * open, so the caller is expected to surface `failed` rather than drop it.
 */
export async function grantProjectAccess(
  projects: Project[],
  tasks: Task[],
): Promise<GrantReport> {
  let home = '';
  try {
    home = (await homeDir()).replace(/\/+$/, '');
  } catch {
    // Without a home directory a `~` path cannot be expanded; absolute paths
    // still work, so carry on rather than granting nothing.
  }

  const report: GrantReport = { granted: [], failed: [], skipped: 0, pending: [] };
  for (const path of projectAccessPaths(projects, tasks, home)) {
    if (granted.has(path)) {
      report.skipped += 1;
      continue;
    }
    try {
      await invoke('allow_project_dir', { path });
      granted.add(path);
      report.granted.push(path);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Not memoised either way: a directory that appears later must be
      // granted then, and a transient failure deserves a retry.
      if (isNotYetPresent(error)) report.pending.push(path);
      else report.failed.push({ path, error });
    }
  }
  return report;
}

/**
 * One line for the error banner, or null when nothing failed.
 *
 * A failed grant is not cosmetic: files in that directory will not open, and
 * the user meets it as "clicking a file does nothing". We have already been
 * bitten once by a core path degrading silently.
 */
export function describeGrantFailures(report: GrantReport): string | null {
  if (report.failed.length === 0) return null;
  const first = report.failed[0];
  if (first === undefined) return null;
  const more =
    report.failed.length > 1 ? ` (and ${report.failed.length - 1} more)` : '';
  return (
    `Files in ${first.path} cannot be opened: ${first.error}${more}. ` +
    `Check the project's folder still exists.`
  );
}
