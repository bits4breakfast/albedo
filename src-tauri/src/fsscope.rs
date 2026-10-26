//! Runtime filesystem scope grants.
//!
//! The static scope in `capabilities/default.json` covers `~/.claude/projects`
//! (transcripts) and `~/agents` (the default worktree root). But a project
//! chooses where its worktrees live -- that is the entire point of the feature --
//! so a user pointing a project at `~/www/acme-worktree` puts every file in
//! it outside the static scope, and opening one fails with "forbidden path".
//!
//! The set of directories to allow is not knowable until the user has told us
//! where their projects are, so the grant is made at runtime, as an `fs:scope`
//! capability added to the main window.
//!
//! Not `fs_scope().allow_directory`, which looks like the obvious API: the
//! plugin builds the scope it returns from an empty config, so it always
//! matches with Tauri's unix default `require_literal_leading_dot: true`, and
//! its `<dir>/**` never reaches `.claude/skills/x/SKILL.md` or
//! `.github/workflows/ci.yml` (#93). A capability's scope is matched with the
//! plugin's `requireLiteralLeadingDot` from `tauri.conf.json`, which is
//! `false`; see `resolve_path` in tauri-plugin-fs's `commands.rs`.
//!
//! WHAT THIS IS NOT: a containment check. `resolveInWorktree` in
//! src/lib/paths.ts remains the single boundary deciding whether a path the
//! transcript mentions may be opened. This only makes the plugin willing to read
//! a directory the user themselves chose with a directory picker; it does not
//! decide which paths within it are legitimate.

use std::path::Path;

use tauri::ipc::CapabilityBuilder;
use tauri::Manager;

/// The `fs:scope` entries for a granted directory: the directory itself and
/// everything under it. The scope reads entries as glob patterns, so the path
/// is escaped first: a `[` or `*` in a folder name stays literal and cannot
/// widen the grant.
fn scope_entries(dir: &Path) -> [serde_json::Value; 2] {
    let escaped = tauri::fs::Pattern::escape(&dir.to_string_lossy());
    [
        serde_json::json!({ "path": escaped }),
        serde_json::json!({ "path": format!("{escaped}/**") }),
    ]
}

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

    let capability = CapabilityBuilder::new("project-dir")
        .window("main")
        .permission_scoped(
            "fs:scope",
            scope_entries(&real).to_vec(),
            Vec::<serde_json::Value>::new(),
        );
    app.add_capability(capability)
        .map_err(|e| format!("could not grant {}: {e}", real.display()))
}

#[cfg(test)]
mod tests {
    use super::scope_entries;
    use std::path::Path;
    use tauri::fs::Pattern;

    /// The plugin's match options with `requireLiteralLeadingDot` as
    /// `tauri.conf.json` sets it, and as Tauri's unix default leaves it.
    fn options(require_literal_leading_dot: bool) -> glob::MatchOptions {
        glob::MatchOptions {
            require_literal_separator: true,
            require_literal_leading_dot,
            ..Default::default()
        }
    }

    fn allowed(dir: &str, file: &str, require_literal_leading_dot: bool) -> bool {
        scope_entries(Path::new(dir)).iter().any(|entry| {
            Pattern::new(entry["path"].as_str().unwrap())
                .unwrap()
                .matches_with(file, options(require_literal_leading_dot))
        })
    }

    #[test]
    fn grants_files_in_dot_folders() {
        let dir = "/Users/me/www/acme-worktree";
        for file in [
            "/Users/me/www/acme-worktree",
            "/Users/me/www/acme-worktree/src/main.rs",
            "/Users/me/www/acme-worktree/.claude/skills/x/SKILL.md",
            "/Users/me/www/acme-worktree/.github/workflows/ci.yml",
            "/Users/me/www/acme-worktree/.env",
        ] {
            assert!(allowed(dir, file, false), "{file}");
        }
        // The bug, kept as a check on the test: with Tauri's unix default the
        // same entries refuse every dot-component.
        assert!(!allowed(
            dir,
            "/Users/me/www/acme-worktree/.claude/skills/x/SKILL.md",
            true
        ));
    }

    #[test]
    fn grants_nothing_outside_the_directory() {
        let dir = "/Users/me/www/acme-worktree";
        for file in [
            "/Users/me/www/acme-worktree-2/.env",
            "/Users/me/www/.env",
            "/Users/me/.ssh/id_ed25519",
        ] {
            assert!(!allowed(dir, file, false), "{file}");
        }
    }

    #[test]
    fn escapes_glob_characters_in_the_path() {
        let dir = "/Users/me/www/[a]*";
        assert!(allowed(dir, "/Users/me/www/[a]*/.claude/x.md", false));
        assert!(!allowed(dir, "/Users/me/www/a/.claude/x.md", false));
        assert!(!allowed(dir, "/Users/me/www/[a]-other/x.md", false));
    }
}
