mod fsx;
mod pty;

use tauri_plugin_sql::{Migration, MigrationKind};

/// Schema is kept in src/db/schema.sql and inlined here so the migration and
/// the checked-in DDL can never drift.
const SCHEMA: &str = include_str!("../../src/db/schema.sql");

pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "initial schema",
        sql: SCHEMA,
        kind: MigrationKind::Up,
    }];

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running albedo");
}
