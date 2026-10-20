-- v2: first-class projects.
--
-- Until now a task carried a bare repo_path and worktrees were forced to
-- ~/agents/<repo>/<slug>. A project names a repository once and says where its
-- worktrees live, so an existing layout (e.g. ~/www/worktrees) is usable
-- instead of being migrated to suit the app.
--
-- schema.sql is migration v1 and is already applied to live databases; it must
-- not be edited. Everything new goes here.

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- Root folder of the project. The git repository itself.
  repo_path TEXT NOT NULL,
  -- Where this project's worktrees are created. User-chosen.
  worktree_root TEXT NOT NULL,
  -- Offered as the default in the new-task dialog. NULL = use the repo's HEAD.
  default_base_branch TEXT,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS projects_repo_path ON projects(repo_path);

ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id);

CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);

-- Backfill deliberately lives in TypeScript, not here.
--
-- The SQL version of this derived the folder basename with an rtrim/replace
-- trick. Verified against real sqlite3: any trailing slash on repo_path yields
-- an EMPTY name and a worktree_root of '~/agents/', because rtrim treats its
-- second argument as a character set. `name TEXT NOT NULL` is satisfied by '',
-- and worktree_root has no unique constraint, so two unrelated projects would
-- silently share one worktree directory. A directory picker returning a
-- trailing slash is not exotic.
--
-- `backfillProjectsFromTasks()` in src/db/projects.ts does this instead: it is
-- idempotent, readable, tested, and collapses `/a/b` and `/a/b/` onto one
-- project rather than creating two.
