//! `~/.albedo/inbox/task-<id>.jsonl`: where an accepted call goes.
//!
//! One JSON line per call, appended with a single write(2) to a file opened
//! O_APPEND, so two sessions' servers (or two calls) can never interleave
//! inside a line. The app (`src/capture/inbox.ts`) reads the file, renames it
//! aside once read, and checks every line again.
//!
//! The line: `{"v":1,"task":<id>,"tool":"…","args":{…},"at":<ms>,"id":"…"}`.

use serde_json::{json, Map, Value};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The line format's version. The app ignores a line with any other.
pub const LINE_VERSION: u64 = 1;

/// The longest line written, newline included. Matches the app's cap, and a
/// write this size to a local file is not split.
pub const MAX_LINE_BYTES: usize = 65_536;

/// `$HOME/.albedo/inbox`.
pub fn dir_under(home: &Path) -> PathBuf {
    home.join(".albedo").join("inbox")
}

pub fn file_for(dir: &Path, task: u64) -> PathBuf {
    dir.join(format!("task-{task}.jsonl"))
}

/// The line for one accepted call, newline included.
pub fn line(
    task: u64,
    tool: &str,
    args: Map<String, Value>,
    at_ms: i64,
    id: &str,
) -> Result<Vec<u8>, String> {
    let v =
        json!({"v": LINE_VERSION, "task": task, "tool": tool, "args": args, "at": at_ms, "id": id});
    let mut out = serde_json::to_vec(&v).map_err(|e| e.to_string())?;
    out.push(b'\n');
    if out.len() > MAX_LINE_BYTES {
        return Err(format!(
            "The request is too large ({} bytes, at most {MAX_LINE_BYTES}); shorten the longest field.",
            out.len()
        ));
    }
    Ok(out)
}

/// Append `bytes` (one whole line) to `path`, creating it and its folder.
pub fn append(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    // One write, not write_all: a short write would leave half a line that a
    // retry could not finish without interleaving. It does not happen for a
    // regular file this size, and if it ever did, the app drops the fragment.
    let n = file.write(bytes)?;
    if n != bytes.len() {
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            format!("short write: {n} of {} bytes", bytes.len()),
        ));
    }
    Ok(())
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("albedo-mcp-inbox-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_line_is_one_json_object_and_one_newline() {
        let mut args = Map::new();
        args.insert("message".into(), "need\nthe key".into());
        let l = line(42, "notify_blocked", args, 1_000, "abc").unwrap();
        assert_eq!(l.iter().filter(|&&b| b == b'\n').count(), 1);
        assert_eq!(*l.last().unwrap(), b'\n');
        let v: Value = serde_json::from_slice(&l).unwrap();
        assert_eq!(
            v,
            json!({"v": 1, "task": 42, "tool": "notify_blocked", "args": {"message": "need\nthe key"}, "at": 1000, "id": "abc"})
        );
    }

    #[test]
    fn an_oversized_line_is_refused_not_cut() {
        let mut args = Map::new();
        args.insert("prompt".into(), "x".repeat(MAX_LINE_BYTES).into());
        assert!(line(1, "request_session", args, 0, "i")
            .unwrap_err()
            .contains("too large"));
    }

    #[test]
    fn appends_create_the_folder_and_keep_earlier_lines() {
        let home = scratch("append");
        let path = file_for(&dir_under(&home), 7);
        append(&path, b"{\"a\":1}\n").unwrap();
        append(&path, b"{\"a\":2}\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":1}\n{\"a\":2}\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = fs::remove_dir_all(&home);
    }
}
