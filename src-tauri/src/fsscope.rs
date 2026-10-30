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
//!
//! `allow_outside_file` is the one other grant (#143): a single file outside
//! every worktree, after the user clicked its path. It IS a check -- one
//! existing, readable, regular file, symlinks resolved, Albedo's and Claude
//! Code's data and known secret stores refused -- because the grant itself is
//! the only thing standing between that click and the rest of the disk.

use std::path::{Component, Path, PathBuf};

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

// ---------------------------------------------------------------------------
// One file outside every worktree (#143)
// ---------------------------------------------------------------------------
//
// A path in a transcript can point outside the task's worktree -- a sibling
// repo's config, a file in /tmp. Opening one is a deliberate click, and the
// grant is sized to that click: the one regular file the path resolves to,
// after symlinks, as a literal (escaped) scope entry. Never its folder, never a
// glob. The webview asks only from a click on the path (src/ui/editor/
// outsideFile.ts); this side cannot see clicks, so it makes sure that whatever
// is asked for is one existing, readable, regular file that is not Albedo's or
// Claude Code's own data and not a well-known secret store.

/// Why a path outside the worktree was not granted. Serialised to the webview
/// as `{ kind, path, message }`, where `kind` is one of the lowercase names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefusalKind {
    /// Not a path this can resolve: empty, a URL, `~user`, a NUL.
    Invalid,
    /// Nothing there (including a symlink whose target is gone).
    Missing,
    /// There, but this process may not read it.
    Unreadable,
    /// A folder. Only a single file is ever granted.
    Directory,
    /// A FIFO, socket or device: reading one can block or has no text.
    Special,
    /// Albedo's or Claude Code's own data, or a secret store.
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct OutsideRefusal {
    pub kind: RefusalKind,
    /// The path as resolved so far: canonical once it could be resolved.
    pub path: String,
    pub message: String,
}

fn refuse(kind: RefusalKind, path: &Path, message: impl Into<String>) -> OutsideRefusal {
    OutsideRefusal {
        kind,
        path: path.to_string_lossy().into_owned(),
        message: message.into(),
    }
}

/// A location no outside-file grant may reach, and the reason shown for it.
#[derive(Debug, Clone)]
pub struct DeniedRoot {
    pub path: PathBuf,
    pub reason: &'static str,
}

/// The fixed refusals under `home`: Albedo's and Claude Code's own data (as
/// before #143, when nothing outside a worktree opened at all), and the
/// well-known places credentials live. A file is refused when it IS one of
/// these or sits anywhere below one.
pub fn home_denied_roots(home: &Path) -> Vec<DeniedRoot> {
    const OWN: &str = "it is Albedo's or Claude Code's own data";
    const SECRET: &str = "it holds keys or credentials";
    let own = [".albedo", ".claude", ".claude.json"];
    let secret = [
        ".ssh",
        ".gnupg",
        ".aws",
        ".azure",
        ".kube",
        ".docker",
        ".config/gh",
        ".config/gcloud",
        ".password-store",
        ".netrc",
        ".git-credentials",
        ".pgpass",
        "Library/Keychains",
    ];
    own.iter()
        .map(|p| DeniedRoot {
            path: home.join(p),
            reason: OWN,
        })
        .chain(secret.iter().map(|p| DeniedRoot {
            path: home.join(p),
            reason: SECRET,
        }))
        .collect()
}

/// `.` and `..` collapsed without touching the disk, as `normalizeAbsolute`
/// does in src/lib/paths.ts, so a relative path lands where it does today.
fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::Normal(seg) => out.push(seg),
            Component::ParentDir => {
                out.pop();
            }
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// The scope entry for one file: the escaped path, matched literally.
fn file_scope_entry(file: &Path) -> serde_json::Value {
    serde_json::json!({ "path": tauri::fs::Pattern::escape(&file.to_string_lossy()) })
}

/// Resolve `raw` (absolute, `~/…`, or relative to `base`) to the one regular
/// file it names, after symlinks, or say why not. Reads nothing but metadata,
/// and opens the file only to check that it can be read.
pub fn resolve_outside_file(
    raw: &str,
    base: &str,
    home: Option<&Path>,
    denied: &[DeniedRoot],
) -> Result<PathBuf, OutsideRefusal> {
    let trimmed = raw.trim();
    let shown = Path::new(trimmed);
    if trimmed.is_empty() || trimmed.contains('\0') || trimmed.contains("://") {
        return Err(refuse(RefusalKind::Invalid, shown, "not a file path"));
    }

    let joined: PathBuf = if trimmed == "~" || trimmed.starts_with("~/") {
        let Some(home) = home else {
            return Err(refuse(
                RefusalKind::Invalid,
                shown,
                "no home folder to expand ~ against",
            ));
        };
        home.join(trimmed.trim_start_matches('~').trim_start_matches('/'))
    } else if trimmed.starts_with('~') {
        return Err(refuse(
            RefusalKind::Invalid,
            shown,
            "~user paths are not expanded",
        ));
    } else if shown.is_absolute() {
        shown.to_path_buf()
    } else {
        let base = Path::new(base);
        if !base.is_absolute() {
            return Err(refuse(
                RefusalKind::Invalid,
                shown,
                "a relative path needs the worktree it is relative to",
            ));
        }
        base.join(shown)
    };
    let lexical = normalize_lexically(&joined);

    let real = std::fs::canonicalize(&lexical).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => refuse(RefusalKind::Missing, &lexical, "does not exist"),
        std::io::ErrorKind::PermissionDenied => {
            refuse(RefusalKind::Unreadable, &lexical, "permission denied")
        }
        _ => refuse(RefusalKind::Unreadable, &lexical, e.to_string()),
    })?;

    // Both spellings are checked, each against the root as given and as
    // resolved: a symlink in either direction must not walk around the list.
    for root in denied {
        let real_root = std::fs::canonicalize(&root.path).ok();
        let hit = |p: &Path| {
            p.starts_with(&root.path) || real_root.as_deref().is_some_and(|r| p.starts_with(r))
        };
        if hit(&real) || hit(&lexical) {
            return Err(refuse(
                RefusalKind::Denied,
                &real,
                format!(
                    "Albedo does not open files under {}: {}",
                    root.path.display(),
                    root.reason
                ),
            ));
        }
    }

    let meta = std::fs::metadata(&real)
        .map_err(|e| refuse(RefusalKind::Unreadable, &real, e.to_string()))?;
    if meta.is_dir() {
        return Err(refuse(
            RefusalKind::Directory,
            &real,
            "is a folder, not a file",
        ));
    }
    if !meta.is_file() {
        return Err(refuse(RefusalKind::Special, &real, "is not a regular file"));
    }
    std::fs::File::open(&real).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => {
            refuse(RefusalKind::Unreadable, &real, "permission denied")
        }
        _ => refuse(RefusalKind::Unreadable, &real, e.to_string()),
    })?;
    Ok(real)
}

/// Grant read/write access to ONE file outside every worktree, which the user
/// has just clicked. Returns the canonical path the grant was made for: the
/// webview opens that path, never the one it asked with.
#[tauri::command]
pub async fn allow_outside_file(
    app: tauri::AppHandle,
    path: String,
    base: String,
) -> Result<String, OutsideRefusal> {
    let home = app.path().home_dir().ok();
    let mut denied = home.as_deref().map(home_denied_roots).unwrap_or_default();
    // The app's own folders, wherever the platform keeps them.
    let resolver = app.path();
    for dir in [
        resolver.app_data_dir(),
        resolver.app_config_dir(),
        resolver.app_local_data_dir(),
        resolver.app_cache_dir(),
        resolver.app_log_dir(),
    ]
    .into_iter()
    .flatten()
    {
        denied.push(DeniedRoot {
            path: dir,
            reason: "it is Albedo's own data",
        });
    }

    let real = resolve_outside_file(&path, &base, home.as_deref(), &denied)?;
    let capability = CapabilityBuilder::new("outside-file")
        .window("main")
        .permission_scoped(
            "fs:scope",
            vec![file_scope_entry(&real)],
            Vec::<serde_json::Value>::new(),
        );
    app.add_capability(capability).map_err(|e| {
        refuse(
            RefusalKind::Unreadable,
            &real,
            format!("could not grant it: {e}"),
        )
    })?;
    Ok(real.to_string_lossy().into_owned())
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

    #[cfg(unix)]
    mod outside_file {
        use super::super::{
            file_scope_entry, home_denied_roots, resolve_outside_file, DeniedRoot, RefusalKind,
        };
        use std::path::{Path, PathBuf};
        use tauri::fs::Pattern;

        /// A fresh folder per test, canonicalised (macOS's temp dir is a symlink).
        fn scratch(name: &str) -> PathBuf {
            let dir =
                std::env::temp_dir().join(format!("albedo-outside-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::canonicalize(&dir).unwrap()
        }

        fn kind(r: Result<PathBuf, super::super::OutsideRefusal>) -> RefusalKind {
            r.expect_err("expected a refusal").kind
        }

        #[test]
        fn resolves_absolute_relative_and_tilde_paths_to_the_real_file() {
            let root = scratch("resolve");
            std::fs::create_dir_all(root.join("other-repo")).unwrap();
            std::fs::create_dir_all(root.join("wt")).unwrap();
            let file = root.join("other-repo/config.tf");
            std::fs::write(&file, "x").unwrap();
            let base = root.join("wt");
            let base = base.to_str().unwrap();

            let abs = resolve_outside_file(file.to_str().unwrap(), base, None, &[]).unwrap();
            assert_eq!(abs, file);
            // Relative to the worktree, `..` collapsed as the webview does it.
            let rel = resolve_outside_file("../other-repo/./config.tf", base, None, &[]).unwrap();
            assert_eq!(rel, file);
            // `~/` expands against the home folder given.
            let home =
                resolve_outside_file("~/other-repo/config.tf", base, Some(&root), &[]).unwrap();
            assert_eq!(home, file);
        }

        #[test]
        fn follows_a_symlink_to_the_file_it_points_at() {
            let root = scratch("symlink");
            let file = root.join("real.txt");
            std::fs::write(&file, "x").unwrap();
            let link = root.join("link.txt");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            let got = resolve_outside_file(link.to_str().unwrap(), "/", None, &[]).unwrap();
            assert_eq!(got, file, "the grant is made for the target, not the link");
        }

        #[test]
        fn refuses_a_directory_even_through_a_symlink() {
            let root = scratch("dir");
            assert_eq!(
                kind(resolve_outside_file(root.to_str().unwrap(), "/", None, &[])),
                RefusalKind::Directory
            );
            let link = root.join("to-dir");
            std::os::unix::fs::symlink(&root, &link).unwrap();
            assert_eq!(
                kind(resolve_outside_file(link.to_str().unwrap(), "/", None, &[])),
                RefusalKind::Directory
            );
        }

        #[test]
        fn says_missing_for_a_path_or_a_dangling_symlink() {
            let root = scratch("missing");
            let gone = root.join("nope.txt");
            assert_eq!(
                kind(resolve_outside_file(gone.to_str().unwrap(), "/", None, &[])),
                RefusalKind::Missing
            );
            let dangling = root.join("dangling");
            std::os::unix::fs::symlink(&gone, &dangling).unwrap();
            assert_eq!(
                kind(resolve_outside_file(
                    dangling.to_str().unwrap(),
                    "/",
                    None,
                    &[]
                )),
                RefusalKind::Missing
            );
        }

        #[test]
        fn says_unreadable_for_a_file_it_may_not_read() {
            use std::os::unix::fs::PermissionsExt;
            let root = scratch("unreadable");
            let file = root.join("locked.txt");
            std::fs::write(&file, "x").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
            let got = resolve_outside_file(file.to_str().unwrap(), "/", None, &[]);
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
            // Root reads anything; the check only means something as a user.
            if unsafe { libc::geteuid() } != 0 {
                assert_eq!(kind(got), RefusalKind::Unreadable);
            }
        }

        #[test]
        fn refuses_denied_locations_and_symlinks_into_them() {
            let root = scratch("denied");
            let home = root.join("home");
            std::fs::create_dir_all(home.join(".ssh")).unwrap();
            std::fs::create_dir_all(home.join(".albedo")).unwrap();
            std::fs::write(home.join(".ssh/id_ed25519"), "k").unwrap();
            std::fs::write(home.join(".albedo/albedo.db"), "d").unwrap();
            std::fs::write(home.join(".claude.json"), "{}").unwrap();
            std::fs::write(home.join(".sshx"), "not a secret").unwrap();
            let denied = home_denied_roots(&home);

            for p in [".ssh/id_ed25519", ".albedo/albedo.db", ".claude.json"] {
                let path = home.join(p);
                assert_eq!(
                    kind(resolve_outside_file(
                        path.to_str().unwrap(),
                        "/",
                        Some(&home),
                        &denied
                    )),
                    RefusalKind::Denied,
                    "{p}"
                );
            }
            // Component-wise, not a string prefix.
            assert!(resolve_outside_file(
                home.join(".sshx").to_str().unwrap(),
                "/",
                Some(&home),
                &denied
            )
            .is_ok());
            // A link from elsewhere into a denied folder is refused by its target.
            let link = root.join("innocent.txt");
            std::os::unix::fs::symlink(home.join(".ssh/id_ed25519"), &link).unwrap();
            assert_eq!(
                kind(resolve_outside_file(
                    link.to_str().unwrap(),
                    "/",
                    Some(&home),
                    &denied
                )),
                RefusalKind::Denied
            );
            // And an app folder handed in by the command.
            let app = root.join("app-data");
            std::fs::create_dir_all(&app).unwrap();
            std::fs::write(app.join("state.json"), "{}").unwrap();
            let extra = [DeniedRoot {
                path: app.clone(),
                reason: "it is Albedo's own data",
            }];
            assert_eq!(
                kind(resolve_outside_file(
                    app.join("state.json").to_str().unwrap(),
                    "/",
                    None,
                    &extra
                )),
                RefusalKind::Denied
            );
        }

        #[test]
        fn refuses_shapes_that_are_not_paths() {
            for raw in [
                "",
                "   ",
                "https://example.com/a.txt",
                "~other/a.txt",
                "a\0b",
            ] {
                assert_eq!(
                    kind(resolve_outside_file(
                        raw,
                        "/wt",
                        Some(Path::new("/home")),
                        &[]
                    )),
                    RefusalKind::Invalid,
                    "{raw:?}"
                );
            }
            // A relative path with no worktree to anchor it.
            assert_eq!(
                kind(resolve_outside_file("a.txt", "", None, &[])),
                RefusalKind::Invalid
            );
        }

        #[test]
        fn refuses_a_fifo() {
            let root = scratch("fifo");
            let fifo = root.join("pipe");
            let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            assert_eq!(
                kind(resolve_outside_file(fifo.to_str().unwrap(), "/", None, &[])),
                RefusalKind::Special
            );
        }

        #[test]
        fn the_scope_entry_matches_that_file_and_nothing_else() {
            let entry = file_scope_entry(Path::new("/Users/me/code/[x]*/config.tf"));
            let pattern = Pattern::new(entry["path"].as_str().unwrap()).unwrap();
            let options = glob::MatchOptions {
                require_literal_separator: true,
                require_literal_leading_dot: false,
                ..Default::default()
            };
            assert!(pattern.matches_with("/Users/me/code/[x]*/config.tf", options));
            for other in [
                "/Users/me/code/[x]*",
                "/Users/me/code/[x]*/config.tf.bak",
                "/Users/me/code/[x]*/config.tf/x",
                "/Users/me/code/[x]*/other.tf",
                "/Users/me/code/x1/config.tf",
            ] {
                assert!(!pattern.matches_with(other, options), "{other}");
            }
        }
    }
}
