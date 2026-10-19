mod fsscope;
mod fsx;
mod pty;

use tauri::menu::{Menu, MenuItem, MenuItemKind, WINDOW_SUBMENU_ID};
use tauri::Emitter;
use tauri_plugin_sql::{Migration, MigrationKind};

/// Event the webview listens for when the user presses the close shortcut.
const CLOSE_TAB_EVENT: &str = "albedo://close-tab";
const CLOSE_TAB_ID: &str = "close-tab";

/// The default menu, with every "Close Window" (Cmd+W) swapped for "Close Editor".
///
/// Albedo has one window, so the stock Cmd+W quit the whole app -- including
/// every live terminal -- when the user only meant to dismiss an open file.
/// The default menu carries a "Close Window" in BOTH the File and the Window
/// submenus, so all of them go; one removed alone leaves the shortcut live.
/// The new item tells the webview, which closes the editor if one is open and
/// otherwise does nothing. The window's own close button is untouched.
fn build_menu<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(handle)?;
    let mut home: Option<tauri::menu::Submenu<R>> = None;
    for top in menu.items()? {
        let MenuItemKind::Submenu(sub) = top else {
            continue;
        };
        for item in sub.items()? {
            if let MenuItemKind::Predefined(p) = &item {
                if p.text()?.contains("Close") {
                    sub.remove(p)?;
                    // The first submenu that had one is where the new item goes.
                    if home.is_none() {
                        home = Some(sub.clone());
                    }
                }
            }
        }
    }
    let close = MenuItem::with_id(
        handle,
        CLOSE_TAB_ID,
        "Close Editor",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    match home {
        Some(sub) => sub.append(&close)?,
        None => {
            if let Some(MenuItemKind::Submenu(window)) = menu.get(WINDOW_SUBMENU_ID) {
                window.append(&close)?;
            }
        }
    }
    Ok(menu)
}

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
/// v5: agent_id, so subagent rows stop colliding with their parent session.
const M0005_SUBAGENTS: &str = include_str!("../../src/db/migrations/0005_subagents.sql");
/// v6: whether Albedo created the task's branch, so archive never deletes one
/// the user already had.
const M0006_CREATED_BRANCH: &str = include_str!("../../src/db/migrations/0006_created_branch.sql");

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
        Migration {
            version: 5,
            description: "subagent rows: agent_id and a re-ingest of every subagents/ transcript",
            sql: M0005_SUBAGENTS,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "tasks.created_branch",
            sql: M0006_CREATED_BRANCH,
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == CLOSE_TAB_ID {
                let _ = app.emit(CLOSE_TAB_EVENT, ());
            }
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
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
            pty::pty_kill_stale,
            fsx::canonicalize_path,
            fsscope::allow_project_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running albedo");
}
