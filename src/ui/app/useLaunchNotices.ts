import { useEffect, useState } from 'react';
import { backfillProjectsFromTasks, listProjects } from '../../db/projects';
import type { BackfillResult } from '../../db/projects';
import { listTasks, repairSelfBasedTasks } from '../../db';
import { defaultBranchOf, repoRootFor } from '../../git/worktree';
import { grantProjectDirs } from '../../lib/fsGrants';
import { KEYS, readPersisted, stringListCodec, writePersisted } from '../persisted';

/**
 * Launch housekeeping, deliberately quiet: the startup backfill, the one
 * error it may put in the banner, and the one-line offers it leaves behind.
 *
 * A user opening Albedo to get to work should not be interrupted by a modal
 * about their database. These are one-line offers they can ignore forever,
 * and dismissing one is remembered.
 */
export default function useLaunchNotices() {
  const [startupError, setStartupError] = useState<string | null>(null);
  const [backfill, setBackfill] = useState<BackfillResult | null>(null);
  /** Notices the user has waved away, so launch housekeeping cannot nag. */
  const [dismissed, setDismissed] = useState<Set<string>>(
    () => new Set(readPersisted(KEYS.dismissedNotices, stringListCodec, [])),
  );

  /**
   * Adopt pre-projects task rows on launch.
   *
   * Idempotent by design -- it only touches `project_id IS NULL` and reuses an
   * existing project for a repo path -- so running it every start is intended.
   * It ends with `emitTasksChanged()`, which the task list is already
   * subscribed to, so the backfilled rows arrive without a second fetch here.
   *
   * A failure is caught but NOT swallowed: if this does not run, new tasks get
   * created without a project, and the first symptom would be somewhere else
   * entirely. It goes in the banner.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // The resolver is injected rather than imported by db/: resolving a
        // repo root shells out to git, and the db layer has no business
        // spawning subprocesses. It is required, not optional-with-a-fallback,
        // because falling back to the raw path IS the bug it exists to fix.
        const result = await backfillProjectsFromTasks(repoRootFor);
        if (cancelled) return;
        // Tasks History saved with their own branch as base (before the fix in
        // SessionBrowser). Best-effort: a failure leaves them as they were.
        await repairSelfBasedTasks(defaultBranchOf).catch((err) =>
          console.warn('[startup] could not repair task bases', err),
        );
        if (cancelled) return;
        setBackfill(result);
        setStartupError(null);

        // Grant the filesystem scope for every directory we may need to read.
        // The static capability only covers ~/.claude/projects and ~/agents; a
        // project pointed anywhere else -- which is the whole point of letting
        // the user choose -- is outside it, and opening a file in it fails with
        // "forbidden path". See src/lib/fsGrants.ts.
        const projects = await listProjects({ includeArchived: true });
        const tasks = await listTasks({ includeArchived: true });
        if (cancelled) return;
        const denied = await grantProjectDirs({
          repoPaths: projects.map((p) => p.repoPath),
          worktreeRoots: projects.map((p) => p.worktreeRoot),
          worktreePaths: tasks.map((t) => t.worktreePath),
        });
        if (!cancelled && denied.length > 0) {
          // Not fatal, but not silent: files in those projects will not open,
          // and a quiet degradation of a core path has bitten this app before.
          setStartupError(
            `Could not grant file access to ${denied.length} project ` +
              `director${denied.length === 1 ? 'y' : 'ies'}: ${denied[0]}. ` +
              'Opening files in those projects will fail.',
          );
        }
      } catch (err) {
        if (cancelled) return;
        const detail = err instanceof Error ? err.message : String(err);
        setStartupError(
          `Could not assign existing tasks to projects: ${detail}. ` +
            'New tasks may be created without one.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const unclaimed = (backfill?.unclaimed ?? []).filter((r) => !dismissed.has(`repo:${r.repoRoot}`));
  const worktreeProjects = (backfill?.worktreeProjects ?? []).filter(
    (f) => !dismissed.has(`wt:${f.project.id}`),
  );

  const dismiss = (key: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(key);
      writePersisted(KEYS.dismissedNotices, stringListCodec, [...next]);
      return next;
    });
  };

  return { startupError, unclaimed, worktreeProjects, dismiss };
}
