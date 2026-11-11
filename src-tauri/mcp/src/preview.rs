//! `show_preview` (#348): the one call that waits for the user.
//!
//! The page is copied the moment the call is made, so the version the user
//! reviews never changes under them, whatever the session does to its file
//! afterwards. The copy and the answer both live in `~/.albedo/previews`:
//!
//!   copy-<task>-<request>.html    written here, read by the app once
//!   answer-<task>-<request>.json  written by the app, only from a click on
//!                                 the card, read here and deleted
//!
//! This mirrors how the PermissionRequest hook waits for its answer file
//! (`src/capture/hookEvents.ts`): one file per request, named by an id only
//! this request has, so an answer can never reach another call. Once the call
//! is over -- answered, cancelled, or the session gone -- nothing reads that
//! name again, so a late answer is never applied.
//!
//! The answer file: `{"text": "<the tool's result>"}`. The app composes the
//! text ("approved", or "changes requested on vN:" and the comments).

use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The largest page copied. A mockup is a few tens of KB; this leaves room
/// for inlined images without letting a session hand the app a huge file.
pub const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

/// The longest answer returned, in characters (the app's cap is the same).
pub const MAX_ANSWER_CHARS: usize = 64_000;

/// Copies and answers older than this are swept: no call waits that long
/// (Claude Code's own limit is about 28 h), and the app reads a copy within
/// seconds of the call.
pub const SWEEP_AFTER: Duration = Duration::from_secs(48 * 60 * 60);

/// `$HOME/.albedo/previews`.
pub fn dir_under(home: &Path) -> PathBuf {
    home.join(".albedo").join("previews")
}

pub fn copy_name(task: u64, request: &str) -> String {
    format!("copy-{task}-{request}.html")
}

pub fn answer_name(task: u64, request: &str) -> String {
    format!("answer-{task}-{request}.json")
}

/// Resolve the session's path: absolute as given, relative against `cwd`.
pub fn resolve(path: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let p = Path::new(path);
    if p.is_absolute() {
        Some(p.to_path_buf())
    } else {
        cwd.map(|c| c.join(p))
    }
}

/// Read the page the session named: a regular file, UTF-8, not empty, within
/// [`MAX_PREVIEW_BYTES`]. `Err` is a sentence for the model.
pub fn read_page(path: &Path) -> Result<String, String> {
    let shown = path.display();
    let meta = fs::metadata(path).map_err(|e| format!("Could not read {shown}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{shown} is not a file."));
    }
    if meta.len() == 0 {
        return Err(format!("{shown} is empty."));
    }
    if meta.len() > MAX_PREVIEW_BYTES {
        return Err(format!(
            "{shown} is {} bytes; at most {MAX_PREVIEW_BYTES}. Keep the mockup small: no large inlined images.",
            meta.len()
        ));
    }
    let bytes = fs::read(path).map_err(|e| format!("Could not read {shown}: {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{shown} is not UTF-8 text."))
}

/// Write the frozen copy: under a scratch name, then renamed, so the app never
/// reads half of it. Owner-only, as the inbox is.
pub fn write_copy(dir: &Path, task: u64, request: &str, page: &str) -> io::Result<PathBuf> {
    create_private_dir(dir)?;
    let final_path = dir.join(copy_name(task, request));
    let tmp = dir.join(format!(".{}.part", copy_name(task, request)));
    let mut opts = OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(page.as_bytes())?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, &final_path)?;
    Ok(final_path)
}

/// What an answer file held.
#[derive(Debug, PartialEq)]
pub enum Answer {
    /// The text to return as the tool's result.
    Text(String),
    /// A file that is not an answer. It is removed, and the call keeps waiting.
    Malformed,
}

/// Take the answer for one request, if it is there: read it and delete it (the
/// deletion is how the app knows it was taken). None while there is none.
pub fn take_answer(path: &Path) -> Option<Answer> {
    let bytes = fs::read(path).ok()?;
    let _ = fs::remove_file(path);
    Some(parse_answer(&bytes))
}

pub fn parse_answer(bytes: &[u8]) -> Answer {
    let Ok(v) = serde_json::from_slice::<Value>(bytes) else {
        return Answer::Malformed;
    };
    match v.get("text").and_then(Value::as_str) {
        Some(t) if !t.trim().is_empty() && t.chars().count() <= MAX_ANSWER_CHARS => {
            Answer::Text(t.to_string())
        }
        _ => Answer::Malformed,
    }
}

/// Remove copies and answers older than [`SWEEP_AFTER`]. Best effort.
pub fn sweep(dir: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        let ours = name.starts_with("copy-")
            || name.starts_with("answer-")
            || name.starts_with(".copy-")
            || name.starts_with(".answer-");
        if !ours {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > SWEEP_AFTER);
        if old {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// A reason Claude Code gave for cancelling, made safe to write: one line,
/// no control characters, at most 200 characters.
pub fn clean_reason(reason: Option<&str>) -> String {
    let r: String = reason
        .unwrap_or("")
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(200)
        .collect();
    let r = r.trim();
    if r.is_empty() {
        "cancelled".into()
    } else {
        r.into()
    }
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
            std::env::temp_dir().join(format!("albedo-mcp-preview-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn relative_paths_resolve_against_the_cwd_only_when_there_is_one() {
        assert_eq!(resolve("/a/b.html", None), Some(PathBuf::from("/a/b.html")));
        assert_eq!(
            resolve("b.html", Some(Path::new("/w"))),
            Some(PathBuf::from("/w/b.html"))
        );
        assert_eq!(resolve("b.html", None), None);
    }

    #[test]
    fn a_page_must_be_a_small_utf8_file() {
        let d = scratch("read");
        fs::create_dir_all(&d).unwrap();
        let ok = d.join("ok.html");
        fs::write(&ok, "<p>hi</p>").unwrap();
        assert_eq!(read_page(&ok).unwrap(), "<p>hi</p>");
        let empty = d.join("empty.html");
        fs::write(&empty, "").unwrap();
        assert!(read_page(&empty).unwrap_err().contains("empty"));
        let bin = d.join("bin.html");
        fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_page(&bin).unwrap_err().contains("UTF-8"));
        let big = d.join("big.html");
        fs::write(&big, vec![b'a'; MAX_PREVIEW_BYTES as usize + 1]).unwrap();
        assert!(read_page(&big).unwrap_err().contains("at most"));
        assert!(read_page(&d).unwrap_err().contains("not a file"));
        assert!(read_page(&d.join("missing.html"))
            .unwrap_err()
            .starts_with("Could not read"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_copy_is_private_and_whole() {
        let d = scratch("copy");
        let p = write_copy(&d, 4, "1-2-3", "<p>v1</p>").unwrap();
        assert_eq!(p, d.join("copy-4-1-2-3.html"));
        assert_eq!(fs::read_to_string(&p).unwrap(), "<p>v1</p>");
        assert!(!d.join(".copy-4-1-2-3.html.part").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn an_answer_is_taken_once_and_must_hold_text() {
        let d = scratch("answer");
        fs::create_dir_all(&d).unwrap();
        let a = d.join(answer_name(4, "r"));
        assert_eq!(take_answer(&a), None);
        fs::write(&a, r#"{"text":"approved"}"#).unwrap();
        assert_eq!(take_answer(&a), Some(Answer::Text("approved".into())));
        assert!(
            !a.exists(),
            "taking it deletes it: the app's acknowledgement"
        );
        assert_eq!(take_answer(&a), None);
        for bad in [
            &b"not json"[..],
            br#"{"text":"  "}"#,
            br#"{"text":3}"#,
            br#"[]"#,
        ] {
            assert_eq!(parse_answer(bad), Answer::Malformed);
        }
        let long = format!(r#"{{"text":"{}"}}"#, "a".repeat(MAX_ANSWER_CHARS + 1));
        assert_eq!(parse_answer(long.as_bytes()), Answer::Malformed);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_sweep_removes_only_our_old_files() {
        let d = scratch("sweep");
        fs::create_dir_all(&d).unwrap();
        for n in ["copy-1-a.html", "answer-1-a.json", "notes.txt"] {
            fs::write(d.join(n), "x").unwrap();
        }
        sweep(&d, SystemTime::now());
        assert_eq!(fs::read_dir(&d).unwrap().count(), 3, "nothing is old yet");
        sweep(
            &d,
            SystemTime::now() + SWEEP_AFTER + Duration::from_secs(60),
        );
        let left: Vec<_> = fs::read_dir(&d)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, ["notes.txt"]);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_cancel_reason_is_one_clean_line() {
        assert_eq!(
            clean_reason(Some("AbortError: user-cancel")),
            "AbortError: user-cancel"
        );
        assert_eq!(clean_reason(Some("a\nb\u{1b}[31m")), "a b [31m");
        assert_eq!(clean_reason(None), "cancelled");
        assert_eq!(clean_reason(Some(&"x".repeat(500))).len(), 200);
    }
}
