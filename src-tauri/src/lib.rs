mod attention;
mod fsscope;
mod fsx;
mod keep_awake;
mod mcp;
mod navguard;
mod oneshot;
mod pty;

use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::menu::{Menu, MenuItem, MenuItemKind, WINDOW_SUBMENU_ID};
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Event the webview listens for when the user presses the close shortcut.
const CLOSE_TAB_EVENT: &str = "albedo://close-tab";
const CLOSE_TAB_ID: &str = "close-tab";

/// Asks the webview to confirm quitting while tasks are busy.
const QUIT_REQUESTED_EVENT: &str = "albedo://quit-requested";
const QUIT_ID: &str = "albedo-quit";

/// How long quitting waits for the terminals' process groups to leave on
/// SIGHUP before it SIGKILLs them. The same as closing a task (pty.rs
/// KILL_GRACE), so Claude Code can finish its transcript write and SessionEnd
/// hooks; quit returns as soon as every group has gone, so this is only spent
/// while something refuses to exit.
const QUIT_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// How many tasks are mid-turn or waiting on the user, as the webview last
/// reported (`set_busy_tasks`). Quitting kills their `claude` processes, so
/// while this is non-zero a quit or a window close asks first.
#[derive(Default)]
struct QuitGuard {
    busy: AtomicUsize,
}

#[tauri::command]
fn set_busy_tasks(guard: tauri::State<'_, QuitGuard>, count: usize) {
    guard.busy.store(count, Ordering::Relaxed);
}

/// The webview's "Quit" after the user confirmed. Exits without asking again.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Quit now, or hand the decision to the webview when tasks are busy.
fn request_quit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let busy = app.state::<QuitGuard>().busy.load(Ordering::Relaxed);
    if busy == 0 || app.emit(QUIT_REQUESTED_EVENT, busy).is_err() {
        app.exit(0);
    }
}

/// The default menu, with every "Close Window" (Cmd+W) swapped for "Close Tab"
/// and the stock "Quit" swapped for one Albedo handles.
///
/// The stock Quit sends AppKit's `terminate:`, which tao cannot cancel, so
/// Cmd+Q would kill every running session without the confirmation the window's
/// close button gives. The replacement goes through `request_quit`. (The Dock's
/// Quit still sends `terminate:`; nothing short of an app delegate catches it.)
///
///
/// Albedo has one window, so the stock Cmd+W quit the whole app -- including
/// every live terminal -- when the user only meant to dismiss an open file.
/// The default menu carries a "Close Window" in BOTH the File and the Window
/// submenus, so all of them go; one removed alone leaves the shortcut live.
/// The new item tells the webview, which closes the active editor tab if one
/// is open and otherwise does nothing. The window's own close button is
/// untouched.
fn build_menu<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(handle)?;
    let mut home: Option<tauri::menu::Submenu<R>> = None;
    for top in menu.items()? {
        let MenuItemKind::Submenu(sub) = top else {
            continue;
        };
        for (index, item) in sub.items()?.into_iter().enumerate() {
            if let MenuItemKind::Predefined(p) = &item {
                let text = p.text()?;
                if text.starts_with("Quit") {
                    sub.remove(p)?;
                    let quit =
                        MenuItem::with_id(handle, QUIT_ID, &text, true, Some("CmdOrCtrl+Q"))?;
                    sub.insert(&quit, index)?;
                    continue;
                }
                if text.contains("Close") {
                    sub.remove(p)?;
                    // The first submenu that had one is where the new item goes.
                    if home.is_none() {
                        home = Some(sub.clone());
                    }
                }
            }
        }
    }
    let close = MenuItem::with_id(handle, CLOSE_TAB_ID, "Close Tab", true, Some("CmdOrCtrl+W"))?;
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
/// v7: review comments on a task's files, sent to Claude Code.
const M0007_COMMENTS: &str = include_str!("../../src/db/migrations/0007_comments.sql");
/// v8: tasks.kind -- work on a branch, or a chat about the code (no branch).
const M0008_TASK_KIND: &str = include_str!("../../src/db/migrations/0008_task_kind.sql");
/// v9: tasks.seen_at -- when the task was last open, for Ready to Review.
const M0009_SEEN_AT: &str = include_str!("../../src/db/migrations/0009_seen_at.sql");
/// v10: reminders -- set on a task, back at their time as a card (#156).
const M0010_REMINDERS: &str = include_str!("../../src/db/migrations/0010_reminders.sql");
/// v11: tasks.summary -- one line on what the task is about, beside its title (#262).
const M0011_TASK_SUMMARY: &str = include_str!("../../src/db/migrations/0011_task_summary.sql");
/// v12: projects.ci_details and ci_details_command -- what a queued CI failure
/// carries (#280).
const M0012_CI_DETAILS: &str = include_str!("../../src/db/migrations/0012_ci_details.sql");
/// v13: tasks.review_url -- the pull request a review task is for (#287).
const M0013_REVIEW_URL: &str = include_str!("../../src/db/migrations/0013_review_url.sql");
/// v14: projects.guide_set_aside and guide_careful -- a project's Review Guide
/// defaults (#295).
const M0014_GUIDE_FOCUS: &str = include_str!("../../src/db/migrations/0014_guide_focus.sql");
/// v15: comments.github and reply_to -- drafts for GitHub on a review task
/// (#287).
const M0015_COMMENT_GITHUB: &str = include_str!("../../src/db/migrations/0015_comment_github.sql");
/// v16: tasks.api_error and api_error_text -- the last turn stopped on an API
/// error (#338).
const M0016_API_ERROR: &str = include_str!("../../src/db/migrations/0016_api_error.sql");
/// v17: tasks.spun_from_task_id -- the task a task was spun out of (#332).
const M0017_SPUN_FROM: &str = include_str!("../../src/db/migrations/0017_spun_from.sql");
/// v18: previews -- HTML mockups a session showed the user for approval (#348).
const M0018_PREVIEWS: &str = include_str!("../../src/db/migrations/0018_previews.sql");
/// v19: messages_au re-indexes search only when id or body is written (#361).
const M0019_FTS_BODY_UPDATES: &str =
    include_str!("../../src/db/migrations/0019_fts_body_updates.sql");

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
        Migration {
            version: 7,
            description: "review comments",
            sql: M0007_COMMENTS,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "tasks.kind",
            sql: M0008_TASK_KIND,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "tasks.seen_at",
            sql: M0009_SEEN_AT,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "reminders",
            sql: M0010_REMINDERS,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "tasks.summary",
            sql: M0011_TASK_SUMMARY,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "projects.ci_details",
            sql: M0012_CI_DETAILS,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "tasks.review_url",
            sql: M0013_REVIEW_URL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "projects.guide_set_aside",
            sql: M0014_GUIDE_FOCUS,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "comments.github",
            sql: M0015_COMMENT_GITHUB,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "tasks.api_error",
            sql: M0016_API_ERROR,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "tasks.spun_from_task_id",
            sql: M0017_SPUN_FROM,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "previews",
            sql: M0018_PREVIEWS,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "messages_au on id and body only",
            sql: M0019_FTS_BODY_UPDATES,
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        // Every frame stays on the app's own pages: a preview's sandboxed
        // page (#348) cannot navigate itself out to the network.
        .plugin(navguard::plugin())
        .menu(build_menu)
        .setup(|app| {
            attention::install(app.handle());
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == CLOSE_TAB_ID {
                let _ = app.emit(CLOSE_TAB_EVENT, ());
            } else if event.id().as_ref() == QUIT_ID {
                request_quit(app);
            }
        })
        // Every shortcut is a keydown listener in the page, so it only fires
        // while the WKWebView is the window's first responder. Activating the
        // window without clicking into the page (Cmd-Tab, the Dock, a closed
        // dialog) can leave it not first responder: the key then reaches no
        // one, matches no menu item, and AppKit beeps. Hand it back on every
        // activation.
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Focused(true) => {
                if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                    let _ = webview.as_ref().set_focus();
                }
            }
            // The only window: closing it quits, so it asks the same question.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let app = window.app_handle();
                if app.state::<QuitGuard>().busy.load(Ordering::Relaxed) > 0 {
                    api.prevent_close();
                    request_quit(app);
                }
            }
            _ => {}
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
        .manage(QuitGuard::default())
        .manage(keep_awake::KeepAwake::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_stale,
            pty::pty_ack,
            fsx::canonicalize_path,
            fsscope::allow_project_dir,
            fsscope::allow_outside_file,
            fsscope::read_plan_file,
            attention::attention_bounce,
            attention::notify_permission,
            attention::notify_post,
            set_busy_tasks,
            keep_awake::set_keep_awake,
            quit_app,
            mcp::mcp_server_path,
            oneshot::claude_oneshot,
        ])
        .build(tauri::generate_context!())
        .expect("error while building albedo")
        .run(|app, event| {
            // Quit, or the last window closed: let the Mac sleep again. A
            // crash needs nothing -- the OS ends the activity with the process.
            if let RunEvent::Exit = event {
                app.state::<keep_awake::KeepAwake>().release();
                // End every terminal's process group, dev servers included:
                // HUP, up to QUIT_GRACE for them to go, then KILL (#360).
                app.state::<pty::PtyRegistry>().shutdown(QUIT_GRACE);
            }
        });
}
