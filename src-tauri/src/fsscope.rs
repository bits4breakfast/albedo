//! Runtime filesystem scope grants.
//!
//! The static scope in `capabilities/default.json` covers `~/.claude/projects`
//! (transcripts) and `~/agents` (the default worktree root). But a project
//! chooses where its worktrees live -- that is the entire point of the feature --
//! so a user pointing a project at `~/www/upsellguru-worktree` puts every file in
//! it outside the static scope, and opening one fails with "forbidden path".
//!
//! Tauri's `Scope::allow_directory` widens the scope at runtime, which is the
//! right shape here: the set of directories to allow is not knowable until the
//! user has told us where their projects are.
//!
//! WHAT THIS IS NOT: a containment check. `resolveInWorktree` in
//! src/lib/paths.ts remains the single boundary deciding whether a path the
//! transcript mentions may be opened. This only makes the plugin willing to read
//! a directory the user themselves chose with a directory picker; it does not
//! decide which paths within it are legitimate.

use tauri::Manager;
use tauri_plugin_fs::FsExt;

/// Grant read/write access to a directory the user has chosen as a project root
/// or worktree root. Idempotent; safe to call on every launch for every project.
#[tauri::command]
pub async fn allow_project_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let requested = std::path::Path::new(&path);
    if !requested.is_absolute() {
        return Err(format!("refusing a relative path: {path}"));
    }

    // Canonicalise first: the grant is recorded against the real path, so a
    // symlinked project root does not silently grant a different tree than the
    // one the caller named.
    let real =
        std::fs::canonicalize(requested).map_err(|e| format!("cannot resolve {path}: {e}"))?;
    if !real.is_dir() {
        return Err(format!("not a directory: {}", real.display()));
    }

    // Cheap guards against a caller that has gone wrong. A project root is a
    // repository or a worktree directory; it is never the filesystem root and
    // never the home directory itself. Granting either would make the static
    // scope pointless.
    let home = app.path().home_dir().ok();
    if real.parent().is_none() || home.as_deref() == Some(real.as_path()) {
        return Err(format!(
            "refusing to grant a filesystem or home root: {}",
            real.display()
        ));
    }

    app.fs_scope()
        .allow_directory(&real, true)
        .map_err(|e| format!("could not grant {}: {e}", real.display()))
}
