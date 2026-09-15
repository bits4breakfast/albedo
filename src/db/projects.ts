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
 * Turn every distinct `tasks.repo_path` that has no project into one.
 *
 * Deliberately in TypeScript rather than in the migration. Deriving a folder
 * basename in pure SQLite needs an rtrim/replace character-set trick that
 * silently returns an EMPTY name for any path with a trailing slash -- and an
 * empty name passes NOT NULL, so the failure is invisible until two projects
 * are found sharing the worktree root `~/agents/`. See the report to the lead.
 *
 * Idempotent: only touches tasks whose `project_id` is still NULL, and reuses
 * an existing project when one already covers that repo path. Safe to call on
 * every app start.
 *
 * @returns number of projects created.
 */
export async function backfillProjectsFromTasks(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ repo_path: string }[]>(
    `SELECT DISTINCT repo_path FROM tasks
      WHERE project_id IS NULL AND repo_path IS NOT NULL AND TRIM(repo_path) != ''`,
  );
  if (rows.length === 0) return 0;

  let created = 0;
  for (const row of rows) {
    const defaults = deriveProjectDefaults(row.repo_path);
    if (defaults.repoPath.length === 0) continue;

    // Two raw paths differing only by a trailing slash collapse onto one
    // project here, which is the point.
    let project = await findProjectByRepo(defaults.repoPath);
    if (project === null) {
      project = await createProject({
        name: defaults.name,
        repoPath: defaults.repoPath,
        worktreeRoot: defaults.worktreeRoot,
        defaultBaseBranch: null,
        taskPromptTemplate: null,
      });
      created += 1;
    }
    // Link by the RAW stored value, which is what the task rows actually hold.
    await db.execute(
      `UPDATE tasks SET project_id = $1 WHERE project_id IS NULL AND repo_path = $2`,
      [project.id, row.repo_path],
    );
  }

  emitTasksChanged();
  if (created > 0) emitProjectsChanged();
  return created;
}
