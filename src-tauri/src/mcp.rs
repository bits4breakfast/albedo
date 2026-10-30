//! Where Albedo's MCP server binary is (#157; the server is `mcp/`).
//!
//! The webview builds each session's `--mcp-config` and needs an absolute
//! path for Claude Code to start. The binary sits beside Albedo's own:
//!
//! - in the app bundle, where `build.sh` puts it as a Tauri sidecar
//!   (`externalBin`, which drops the target-triple suffix when bundling);
//! - in a dev build, in the same `target/<profile>/` folder, because the
//!   server is a member of this Cargo workspace (`cargo build -p albedo-mcp`,
//!   which `tauri dev`'s `beforeDevCommand` runs).
//!
//! None means "not there": the session starts without the server, as every
//! session did before it existed.

use std::path::{Path, PathBuf};

/// The server's file name: `albedo-mcp`, `albedo-mcp.exe` on Windows.
const SERVER_NAME: &str = if cfg!(windows) {
    "albedo-mcp.exe"
} else {
    "albedo-mcp"
};

fn server_beside(exe: &Path) -> Option<PathBuf> {
    let candidate = exe.parent()?.join(SERVER_NAME);
    candidate.is_file().then_some(candidate)
}

#[tauri::command]
pub fn mcp_server_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    // Through a symlink (a dev binary run from elsewhere), the real folder.
    let exe = exe.canonicalize().unwrap_or(exe);
    server_beside(&exe).map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn found_only_when_the_file_is_beside_the_executable() {
        let dir = std::env::temp_dir().join(format!("albedo-mcp-path-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("albedo");
        assert_eq!(server_beside(&exe), None);
        std::fs::create_dir(dir.join(SERVER_NAME)).unwrap();
        assert_eq!(
            server_beside(&exe),
            None,
            "a folder of that name is not the server"
        );
        std::fs::remove_dir(dir.join(SERVER_NAME)).unwrap();
        std::fs::write(dir.join(SERVER_NAME), b"").unwrap();
        assert_eq!(server_beside(&exe), Some(dir.join(SERVER_NAME)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
