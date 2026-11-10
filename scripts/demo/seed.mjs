// The demo profile's database, made before the app first opens it.
//
// The app applies its migrations through tauri-plugin-sql, i.e. sqlx, which
// records each one in `_sqlx_migrations` with a SHA-384 of its SQL and refuses
// to start if an applied one no longer matches. So this applies exactly the
// migrations src-tauri/src/lib.rs registers, read from that file, and records
// them the way sqlx 0.8 does (sqlx-sqlite's migrate.rs). A migration added to
// lib.rs is picked up here with no change; a mismatch shows up as the app
// refusing the database, loudly, never as a quietly wrong one.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

/** The migrations lib.rs registers, in order: version, description, SQL. */
export function migrationsFromLibRs(libRsPath) {
  const src = readFileSync(libRsPath, 'utf8');
  const dir = dirname(libRsPath);
  const files = new Map();
  for (const m of src.matchAll(/const (\w+): &str = include_str!\("([^"]+)"\);/g)) {
    files.set(m[1], resolve(dir, m[2]));
  }
  const out = [];
  for (const m of src.matchAll(
    /Migration \{\s*version: (\d+),\s*description: "([^"]*)",\s*sql: (\w+),\s*kind: MigrationKind::Up,\s*\}/g,
  )) {
    const path = files.get(m[3]);
    if (!path) throw new Error(`lib.rs: no include_str! for ${m[3]}`);
    out.push({ version: Number(m[1]), description: m[2], sql: readFileSync(path, 'utf8') });
  }
  if (out.length === 0) throw new Error('lib.rs: no migrations found; has the Migration list changed shape?');
  // Contiguous from 1, but for one known gap: #287 takes v15 while #295's
  // v14 (PR #297) is not on main yet. Remove KNOWN_GAPS once v14 is there.
  const KNOWN_GAPS = new Set([14]);
  let want = 1;
  for (const mig of out) {
    while (mig.version !== want && KNOWN_GAPS.has(want)) want += 1;
    if (mig.version !== want) throw new Error(`lib.rs: migration ${want} is missing or out of order`);
    want += 1;
  }
  return out;
}

/** Apply every migration and record it as sqlx would have. */
export function migrate(db, migrations) {
  db.exec(`CREATE TABLE IF NOT EXISTS _sqlx_migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL,
    checksum BLOB NOT NULL,
    execution_time BIGINT NOT NULL
  )`);
  const record = db.prepare(
    'INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?, ?, TRUE, ?, -1)',
  );
  for (const m of migrations) {
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.description, createHash('sha384').update(m.sql, 'utf8').digest());
    })();
  }
}

/**
 * Projects and tasks, as the app's own createProject and createTask would
 * have written them. Rows are ordered so ids are stable from run to run, which
 * keeps the app's per-task and per-project preferences pointing at the same
 * tasks after a reset.
 */
export function seed(db, scenario, now) {
  const projectIds = new Map();
  const addProject = db.prepare(
    `INSERT INTO projects (name, repo_path, worktree_root, default_base_branch, created_at, archived_at, task_prompt_template)
     VALUES (?, ?, ?, 'main', ?, NULL, NULL)`,
  );
  for (const p of scenario.projects) {
    const r = addProject.run(p.name, p.repo, p.worktreeRoot, now - 14 * 86_400_000);
    projectIds.set(p.name, Number(r.lastInsertRowid));
  }
  const addTask = db.prepare(
    `INSERT INTO tasks (title, project_id, repo_path, base_branch, branch, worktree_path, session_id, owns_worktree,
                        created_branch, kind, status, created_at, last_activity_at, seen_at, summary)
     VALUES (?, ?, ?, 'main', ?, ?, ?, 1, 1, 'work', ?, ?, ?, ?, ?)`,
  );
  const taskIds = new Map();
  for (const t of scenario.tasks) {
    const last = [...t.history].reverse().find((l) => l.timestamp);
    const lastAt = last ? Date.parse(last.timestamp) : null;
    const r = addTask.run(
      t.title,
      projectIds.get(t.project),
      t.repo,
      t.branch,
      t.worktree,
      t.sessionId,
      t.done ? 'done' : 'idle',
      t.createdAt,
      lastAt,
      t.seen ? now : null,
      t.summary,
    );
    taskIds.set(t.key, Number(r.lastInsertRowid));
  }
  return { projectIds, taskIds };
}

/** Create the database file at `path` from scratch. */
export function createDatabase(path, { libRs, scenario, now }) {
  const db = new Database(path);
  try {
    migrate(db, migrationsFromLibRs(libRs));
    return seed(db, scenario, now);
  } finally {
    db.close();
  }
}
