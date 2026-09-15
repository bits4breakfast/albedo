mod fsscope;
mod fsx;
mod pty;

use tauri_plugin_sql::{Migration, MigrationKind};

/// Schema is kept in src/db/schema.sql and inlined here so the migration and
/// the checked-in DDL can never drift.
const SCHEMA: &str = include_str!("../../src/db/schema.sql");
/// v2: projects. schema.sql is v1 and is already applied to live databases, so
/// it must never be edited -- additions go in a new migration file.
const M0002_PROJECTS: &str = include_str!("../../src/db/migrations/0002_projects.sql");
/// v3: per-project initial-prompt template, for issue-keyed tasks.
const M0003_TASK_PROMPT: &str = include_str!("../../src/db/migrations/0003_task_prompt.sql");
/// v4: resuming captured sessions -- worktree ownership, and session titles.
const M0004_RESUME: &str = include_str!("../../src/db/migrations/0004_resume.sql");

pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial schema",
            sql: SCHEMA,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "projects",
            sql: M0002_PROJECTS,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "task prompt template",
            sql: M0003_TASK_PROMPT,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "resume: worktree ownership and session titles",
            sql: M0004_RESUME,
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:albedo.db", migrations)
                .build(),
        )
        .manage(pty::PtyRegistry::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            fsx::canonicalize_path,
            fsscope::allow_project_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running albedo");
}
