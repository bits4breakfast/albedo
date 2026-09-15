/**
 * src/db/projects.ts
 *
 * Projects: a repository named once, plus the directory its worktrees live in.
 *
 * Exists so the worktree location is the user's choice instead of a hardcoded
 * `~/agents/<repo>/<slug>` -- an existing layout stays usable rather than
 * having to be migrated to suit the app.
 *
 * Schema comes from migration v2 (src/db/migrations/0002_projects.sql).
 * src/db/schema.sql is migration v1 and is already applied to live databases;
 * it must never be edited, because sqlx checksums each applied migration and a
 * changed file fails startup rather than re-running.
 */

import type { NewProject, Project } from '../types';
import { emitTasksChanged, getDb } from './index';

// ---------------------------------------------------------------------------
// Change notification
// ---------------------------------------------------------------------------

const projectListeners = new Set<() => void>();

/**
 * Fires after any write that mutates a `projects` row. In-process only -- one
 * app, one window -- mirroring onTasksChanged.
 *
 * @returns unsubscribe
 */
export function onProjectsChanged(cb: () => void): () => void {
  projectListeners.add(cb);
  return () => {
    projectListeners.delete(cb);
  };
}

/** Notify listeners. A throwing subscriber must not break the others. */
export function emitProjectsChanged(): void {
  for (const cb of [...projectListeners]) {
    try {
      cb();
    } catch {
      // a broken subscriber is not the writer's problem
    }
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: number;
  name: string;
  repo_path: string;
  worktree_root: string;
  default_base_branch: string | null;
  task_prompt_template: string | null;
  created_at: number;
  archived_at: number | null;
}

const PROJECT_SELECT =
  'id, name, repo_path, worktree_root, default_base_branch, task_prompt_template, created_at, archived_at';

const PROJECT_COLUMN: Readonly<Record<keyof NewProject, string>> = {
  name: 'name',
  repoPath: 'repo_path',
  worktreeRoot: 'worktree_root',
  defaultBaseBranch: 'default_base_branch',
  taskPromptTemplate: 'task_prompt_template',
};

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    repoPath: r.repo_path,
    worktreeRoot: r.worktree_root,
    defaultBaseBranch: r.default_base_branch,
    taskPromptTemplate: r.task_prompt_template,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

// ---------------------------------------------------------------------------
// Path helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Drop trailing slashes so `/a/b` and `/a/b/` are one project, not two.
 *
 * `repo_path` is UNIQUE, and without this a directory picker that returns a
 * trailing slash silently creates a duplicate project for the same repository,
 * with its own worktree root. A lone `/` is preserved.
 */
export function normalizeRepoPath(repoPath: string): string {
  const trimmed = repoPath.trim();
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped.length > 0 ? stripped : trimmed.length > 0 ? '/' : '';
}

/**
 * Collapse "no initial prompt" to a single representation.
 *
 * NULL and '' both mean unset, so storing both lets a distinction nobody
 * intended leak into every `if (project.taskPromptTemplate)` downstream. A
 * whitespace-only template is unset too -- it would expand to a prompt of
 * spaces, which is worse than none.
 */
export function normalizePromptTemplate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Folder basename of a repo path. `/a/b/` -> `b`, not `''`. */
export function projectNameFor(repoPath: string): string {
  const norm = normalizeRepoPath(repoPath);
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  // Degenerate input (`/`, or empty) still has to satisfy NOT NULL and still
  // has to be something a human can see in a list.
  return base.length > 0 ? base : 'repo';
}

/**
 * Defaults for a project the user has not configured yet.
 *
 * `worktreeRoot` reproduces the pre-projects layout, `~/agents/<repo>`, so
 * that worktrees created before projects existed stay exactly where they are
 * and stay reachable. A leading `~` is expanded by the worktree workstream at
 * use time, per docs/INTERFACES.md.
 */
export function deriveProjectDefaults(repoPath: string): {
  name: string;
  repoPath: string;
  worktreeRoot: string;
} {
  const norm = normalizeRepoPath(repoPath);
  const name = projectNameFor(norm);
  return { name, repoPath: norm, worktreeRoot: `~/agents/${name}` };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a repo path already belongs to a project.
 *
 * Deliberately NOT a silent "return the existing row": the caller has to
 * decide whether it meant to edit that project. Returning it quietly would
 * attach the new task to someone else's worktree root, and the user would find
 * out by watching a worktree appear in the wrong place.
 */
export class ProjectExistsError extends Error {
  readonly existing: Project;

  constructor(existing: Project) {
    super(
      `A project for ${existing.repoPath} already exists: "${existing.name}" ` +
        `(id ${existing.id}, worktrees in ${existing.worktreeRoot}). ` +
        `Edit that project instead of creating a second one.`,
    );
    this.name = 'ProjectExistsError';
    this.existing = existing;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listProjects(opts?: { includeArchived?: boolean }): Promise<Project[]> {
  const db = await getDb();
  const where = opts?.includeArchived === true ? '' : ' WHERE archived_at IS NULL';
  const rows = await db.select<ProjectRow[]>(
    `SELECT ${PROJECT_SELECT} FROM projects${where} ORDER BY name COLLATE NOCASE ASC, id ASC`,
  );
  return rows.map(toProject);
}

export async function getProject(id: number): Promise<Project | null> {
  const db = await getDb();
  const rows = await db.select<ProjectRow[]>(
    `SELECT ${PROJECT_SELECT} FROM projects WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toProject(row) : null;
}

/** Lookup by repository path. Trailing slashes are normalised away first. */
export async function findProjectByRepo(repoPath: string): Promise<Project | null> {
  const db = await getDb();
  const rows = await db.select<ProjectRow[]>(
    `SELECT ${PROJECT_SELECT} FROM projects WHERE repo_path = $1`,
    [normalizeRepoPath(repoPath)],
  );
  const row = rows[0];
  return row ? toProject(row) : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createProject(p: NewProject): Promise<Project> {
  const repoPath = normalizeRepoPath(p.repoPath);
  if (repoPath.length === 0) throw new Error('createProject: repoPath is required');

  const existing = await findProjectByRepo(repoPath);
  if (existing !== null) throw new ProjectExistsError(existing);

  const createdAt = Date.now();
  const name = p.name.trim().length > 0 ? p.name.trim() : projectNameFor(repoPath);
  const taskPromptTemplate = normalizePromptTemplate(p.taskPromptTemplate);
  const db = await getDb();
  let res;
  try {
    res = await db.execute(
      `INSERT INTO projects (name, repo_path, worktree_root, default_base_branch, task_prompt_template, created_at, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
      [name, repoPath, p.worktreeRoot, p.defaultBaseBranch, taskPromptTemplate, createdAt],
    );
  } catch (err: unknown) {
    // The check above races against another writer. The UNIQUE index is the
    // real guarantee, so translate its error into the same clear failure
    // rather than leaking a driver message.
    const raced = await findProjectByRepo(repoPath);
    if (raced !== null) throw new ProjectExistsError(raced);
    throw err;
  }

  const id = res.lastInsertId;
  if (typeof id !== 'number') throw new Error('createProject: driver returned no lastInsertId');

  emitProjectsChanged();
  return {
    id,
    name,
    repoPath,
    worktreeRoot: p.worktreeRoot,
    defaultBaseBranch: p.defaultBaseBranch,
    taskPromptTemplate,
    createdAt,
    archivedAt: null,
  };
}

export async function updateProject(id: number, patch: Partial<NewProject>): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  for (const key of Object.keys(patch) as (keyof NewProject)[]) {
    const column = PROJECT_COLUMN[key];
    if (column === undefined) continue; // unknown field: ignore, never inject
    let value: unknown = patch[key];
    // `undefined` means "not mentioned", so leave the column alone. Spreading a
    // form object whose optional fields were never filled in must not wipe
    // them. Clearing is done with null or '', which normalise to NULL.
    if (value === undefined) continue;
    if (key === 'taskPromptTemplate') {
      // Same normalisation as createProject, so clearing the field in the UI
      // stores NULL rather than ''.
      value = normalizePromptTemplate(value as string | null | undefined);
    }
    if (key === 'repoPath') {
      const norm = normalizeRepoPath(String(value));
      // Moving a project onto another project's repo would violate the UNIQUE
      // index; fail with the same clear error as createProject.
      const clash = await findProjectByRepo(norm);
      if (clash !== null && clash.id !== id) throw new ProjectExistsError(clash);
      value = norm;
    }
    binds.push(value);
    sets.push(`${column} = $${binds.length}`);
  }
  if (sets.length === 0) return;

  binds.push(id);
  const db = await getDb();
  await db.execute(`UPDATE projects SET ${sets.join(', ')} WHERE id = $${binds.length}`, binds);
  emitProjectsChanged();
}

/** Soft delete. Tasks keep pointing at the project so history stays readable. */
export async function archiveProject(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE projects SET archived_at = $1 WHERE id = $2 AND archived_at IS NULL`, [
    Date.now(),
    id,
  ]);
  emitProjectsChanged();
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/**
 * Resolves any path inside a git repository to that repository's ROOT.
 *
 * Injected rather than imported. `repoRootFor` in src/git/worktree.ts spawns a
 * git subprocess, and this module has no business doing that -- the same rule
 * that keeps `cwdExists` null in sessions.ts. Importing it here would also be
 * the first coupling between two peer feature modules; the caller sits above
 * both and can supply it.
 *
 * REQUIRED, not optional with a raw-path fallback: falling back to the raw
 * path is precisely the bug this parameter exists to prevent, so the compiler
 * should insist rather than let a caller silently reintroduce it.
 */
export type RepoRootResolver = (path: string) => Promise<string>;

/** Cache + failure containment around a caller-supplied resolver. */
function memoisedResolver(resolve: RepoRootResolver): (p: string) => Promise<string> {
  const cache = new Map<string, string>();
  return async (raw: string) => {
    const key = normalizeRepoPath(raw);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let root = key;
    try {
      const resolved = normalizeRepoPath(await resolve(key));
      if (resolved.length > 0) root = resolved;
    } catch {
      // Not a git directory, deleted, or git unavailable. Fall back to the
      // path itself: no worse than before, and better than aborting a startup
      // repair over one unreadable directory.
    }
    cache.set(key, root);
    return root;
  };
}

export interface WorktreeProjectFinding {
  /** The project whose repo_path is really a worktree. */
  project: Project;
  /** The project whose repo_path is the actual repository root. */
  parent: Project;
}

/**
 * Projects that are provably a git WORKTREE of another project's repository.
 *
 * Provable, not heuristic: git itself reports the repository root, and a
 * project whose root is another project's `repo_path` is a linked worktree of
 * it. `/Users/x/www/upsellguru-UP-2368` resolving to `/Users/x/www/upsellguru`
 * is not a guess.
 *
 * DETECTION ONLY. Merging or deleting the project is deliberately not done
 * here: it means rewriting or removing a row the user can see and may have
 * created, and an auto-merge that picks the wrong survivor costs far more to
 * undo than the duplicate costs to live with. The UI can offer "this looks
 * like a worktree of X -- archive it", which is honest and actionable.
 */
export async function findWorktreeProjects(
  resolve: RepoRootResolver,
): Promise<WorktreeProjectFinding[]> {
  const projects = await listProjects({ includeArchived: true });
  const byRepoPath = new Map(projects.map((p) => [p.repoPath, p]));
  const rootOf = memoisedResolver(resolve);

  const out: WorktreeProjectFinding[] = [];
  for (const project of projects) {
    const root = await rootOf(project.repoPath);
    if (root === project.repoPath) continue; // it IS the repository
    const parent = byRepoPath.get(root);
    if (parent !== undefined && parent.id !== project.id) out.push({ project, parent });
  }
  return out;
}

export interface BackfillResult {
  /** Tasks whose project association was added or corrected. */
  relinked: number;
  /** Projects that are really worktrees of another. Reported, never merged. */
  worktreeProjects: WorktreeProjectFinding[];
  /**
   * Repo roots with captured history that no project claims. Offered to the
   * user for import; NEVER turned into projects here.
   */
  unclaimed: UnclaimedRepo[];
}

/**
 * Associate every task with the project for the repository it actually lives in.
 *
 * ### GOVERNING RULE: resolve and LINK automatically, NEVER CREATE.
 *
 * Linking is provably correct -- git states that a directory belongs to a
 * repository, so there is nothing to ask about. Creating a project is a
 * decision: the user names it and configures its worktree root, base branch
 * and prompt template. Inventing one from a directory path produces rows they
 * did not ask for and will not recognise.
 *
 * That is what this function used to do. It grouped by the RAW
 * `tasks.repo_path`, so a task running in a git WORKTREE never matched its
 * real project and a second project was created named after the worktree
 * folder -- on every launch, for every unseen directory. On the user's
 * database that produced `upsellguru-UP-2368` beside their real `upsellguru`,
 * and the task appeared under a separate named tab. Correct resolution alone
 * would have produced FEWER bogus projects, not none; not creating is what
 * produces none.
 *
 * A task whose repository has no project keeps `project_id = NULL` and sits in
 * "Other", which is exactly what that tab is for. The repository shows up in
 * `unclaimed` for the user to import if they want it.
 *
 * Idempotent and safe on every launch: it only ever adds or corrects a link.
 */
export async function backfillProjectsFromTasks(
  resolveRepoRoot: RepoRootResolver,
): Promise<BackfillResult> {
  const db = await getDb();
  const rootOf = memoisedResolver(resolveRepoRoot);
  let relinked = 0;

  // --- 1. tasks with no project ---------------------------------------------
  const unassigned = await db.select<{ repo_path: string }[]>(
    `SELECT DISTINCT repo_path FROM tasks
      WHERE project_id IS NULL AND repo_path IS NOT NULL AND TRIM(repo_path) != ''`,
  );

  for (const row of unassigned) {
    // Resolve BEFORE matching. Two tasks in two worktrees of one repository
    // collapse onto that repository here, which is the whole point.
    const root = await rootOf(row.repo_path);
    if (root.length === 0) continue;

    const project = await findProjectByRepo(root);
    if (project === null) continue; // leave it in "Other"; never invent one

    // Link by the RAW stored value, which is what the task rows actually hold.
    const res = await db.execute(
      `UPDATE tasks SET project_id = $1 WHERE project_id IS NULL AND repo_path = $2`,
      [project.id, row.repo_path],
    );
    relinked += res.rowsAffected;
  }

  // --- 2. tasks pointing at a project that is really a worktree -------------
  const worktreeProjects = await findWorktreeProjects(resolveRepoRoot);
  for (const { project, parent } of worktreeProjects) {
    const res = await db.execute(`UPDATE tasks SET project_id = $1 WHERE project_id = $2`, [
      parent.id,
      project.id,
    ]);
    relinked += res.rowsAffected;
  }

  if (relinked > 0) emitTasksChanged();
  return { relinked, worktreeProjects, unclaimed: await listUnclaimedRepos(resolveRepoRoot) };
}

// ---------------------------------------------------------------------------
// Import candidates
// ---------------------------------------------------------------------------

export interface UnclaimedRepo {
  /** Repository root, as git reports it. The identity key. */
  repoRoot: string;
  /** Folder basename, offered as the project name. The user may change it. */
  suggestedName: string;
  /** Captured sessions whose cwd resolves here. */
  sessionCount: number;
  messageCount: number;
  /** Newest captured activity, epoch ms. Null when nothing is captured. */
  lastActivityAt: number | null;
  /** Tasks with no project whose repo_path resolves here. */
  taskCount: number;
  /**
   * Distinct directories that resolved to this root — the repository itself
   * and any worktrees of it. Shown so the user can see WHY it is being
   * offered, rather than being asked to trust a bare path.
   */
  directories: string[];
}

/**
 * Repositories Albedo has history for that no project claims.
 *
 * The honest alternative to inventing projects: show what was found and let
 * the user decide, the same shape as the reconcile view. Archived projects
 * count as claimed -- re-offering something the user archived is nagging.
 *
 * Ordered by most recent activity, because that is the one the user is
 * looking for.
 */
export async function listUnclaimedRepos(
  resolveRepoRoot: RepoRootResolver,
): Promise<UnclaimedRepo[]> {
  const db = await getDb();
  const rootOf = memoisedResolver(resolveRepoRoot);

  // Per-cwd session and message totals. The inner per-session grouping is what
  // stops a session that spans several transcript files counting twice.
  const captured = await db.select<
    { cwd: string; session_count: number; message_count: number; last_ts: number | null }[]
  >(
    `SELECT cwd,
            COUNT(*)        AS session_count,
            SUM(msgs)       AS message_count,
            MAX(last_ts)    AS last_ts
       FROM (
         SELECT s.cwd AS cwd, s.session_id AS session_id,
                COUNT(m.id) AS msgs, MAX(m.ts) AS last_ts
           FROM (SELECT session_id, MAX(updated_at) AS newest, cwd
                   FROM transcript_files
                  WHERE cwd IS NOT NULL AND TRIM(cwd) != ''
                  GROUP BY session_id) s
           JOIN messages m ON m.session_id = s.session_id
          GROUP BY s.session_id
       )
      GROUP BY cwd`,
  );

  const taskDirs = await db.select<{ repo_path: string; task_count: number }[]>(
    `SELECT repo_path, COUNT(*) AS task_count FROM tasks
      WHERE project_id IS NULL AND repo_path IS NOT NULL AND TRIM(repo_path) != ''
      GROUP BY repo_path`,
  );

  // Archived projects still count as claimed.
  const claimed = new Set(
    (await listProjects({ includeArchived: true })).map((p) => p.repoPath),
  );

  const byRoot = new Map<string, UnclaimedRepo>();
  const take = (root: string, directory: string): UnclaimedRepo | null => {
    if (root.length === 0 || claimed.has(root)) return null;
    let entry = byRoot.get(root);
    if (entry === undefined) {
      entry = {
        repoRoot: root,
        suggestedName: projectNameFor(root),
        sessionCount: 0,
        messageCount: 0,
        lastActivityAt: null,
        taskCount: 0,
        directories: [],
      };
      byRoot.set(root, entry);
    }
    if (!entry.directories.includes(directory)) entry.directories.push(directory);
    return entry;
  };

  for (const row of captured) {
    const entry = take(await rootOf(row.cwd), normalizeRepoPath(row.cwd));
    if (entry === null) continue;
    entry.sessionCount += row.session_count;
    entry.messageCount += row.message_count;
    if (row.last_ts !== null && (entry.lastActivityAt === null || row.last_ts > entry.lastActivityAt)) {
      entry.lastActivityAt = row.last_ts;
    }
  }

  for (const row of taskDirs) {
    const entry = take(await rootOf(row.repo_path), normalizeRepoPath(row.repo_path));
    if (entry === null) continue;
    entry.taskCount += row.task_count;
  }

  return [...byRoot.values()].sort(
    (a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.repoRoot.localeCompare(b.repoRoot),
  );
}
