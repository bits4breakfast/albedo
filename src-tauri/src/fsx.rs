//! Filesystem helpers that `tauri-plugin-fs` does not provide.
//!
//! The plugin exposes `stat`/`lstat` but no `canonicalize`, which leaves the
//! worktree containment check in `src/lib/paths.ts` unable to follow a symlink
//! to its target. Without this it has to fail closed and refuse every symlink
//! -- including legitimate in-tree ones, of which a real repo has plenty
//! (workspace links under `node_modules`, Laravel's `public/storage`).

use std::path::PathBuf;

/// Resolve a path to its canonical form, following symlinks.
///
/// This only *resolves* a path, it never reads file contents. Containment
/// against the task's worktree is enforced in `resolveInWorktree`, on whatever
/// this returns -- deliberately, so the security decision stays in the single
/// place that documents it rather than being split across two languages.
#[tauri::command]
pub async fn canonicalize_path(path: String) -> Result<String, String> {
    let resolved: PathBuf =
        std::fs::canonicalize(&path).map_err(|e| format!("cannot resolve {path}: {e}"))?;
    resolved
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("resolved path for {path} is not valid UTF-8"))
}
