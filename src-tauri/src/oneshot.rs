//! One-shot `claude -p` for the Review Guide (#186), and nothing else.
//!
//! The narrow channel CLAUDE.md records (owner decision 2026-11-02): Albedo may
//! run Claude Code once, non-interactively, with no tools, on Haiku, and read
//! its single JSON result from stdout. It never touches a task's own session,
//! never runs in a pty, and its output is a structured JSON document -- never
//! terminal bytes. What that document means is `src/guide/writer.ts`'s
//! business alone; this file hands back stdout, stderr and the exit code
//! untouched.
//!
//! Every flag is fixed here rather than passed from the page, so the frontend
//! can choose the words (system prompt, schema, input) but not the shape of
//! the run: it cannot ask for tools, another model, a session that persists,
//! or the user's MCP servers. Measured on Claude Code 2.1.316:
//!
//! - `--tools ""` leaves no built-in tools; `--json-schema` still works (it is
//!   answered through Claude Code's own structured-output tool, so the result
//!   reports `num_turns: 2`) and the parsed object is `structured_output`.
//! - `--strict-mcp-config` (no `--mcp-config`): the user's MCP servers are not
//!   loaded. Without it the tiniest call cost ~181k input tokens here.
//! - `--system-prompt` replaces Claude Code's own (~3.8k -> ~1k tokens).
//! - `--settings {"disableAllHooks":true}`: a project's `UserPromptSubmit`
//!   hook otherwise adds text to the prompt (verified: it did).
//! - `--no-session-persistence`: no transcript is written, so capture never
//!   sees this run. Claude Code still creates an empty
//!   `~/.claude/projects/<dir>/memory/` for the folder, and adds no trust entry
//!   to `~/.claude.json` in print mode.
//! - The project's CLAUDE.md IS loaded from the working folder (verified), so
//!   the run happens in `~/.albedo/guide`, a folder of Albedo's own with none:
//!   the model needs nothing from the worktree that the prompt does not carry.
//! - A failure (e.g. an unknown model) still prints one JSON line with
//!   `is_error: true`, and exits 1. A missing `claude` is the shell's 127.
//!
//! It goes through the user's login shell, exactly as `pty.rs` does, for the
//! same two reasons: a Finder-launched app's PATH does not reach `claude`, and
//! the `unset` of the Anthropic variables must run after the profile (hard
//! rule 3). The prompt goes in on stdin, so no argv limit applies to it.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Manager;

use crate::pty::{login_shell, shell_script, SpawnOptions, STRIPPED_ENV};

/// The longest a caller may ask to wait. A guide call is minutes at most.
const MAX_TIMEOUT_MS: u64 = 15 * 60 * 1000;
/// Kept from each stream; a guide's JSON is a few kilobytes.
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OneshotResult {
    /// The process's exit code; None when it was killed (timeout) or signalled.
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

/// The fixed argv after `claude`. The page supplies only the words.
pub(crate) fn claude_args(system_prompt: &str, json_schema: &str) -> Vec<String> {
    [
        "-p",
        "--model",
        "haiku",
        "--output-format",
        "json",
        "--tools",
        "",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--settings",
        r#"{"disableAllHooks":true}"#,
        "--system-prompt",
        system_prompt,
        "--json-schema",
        json_schema,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Run `claude -p` once with `prompt` on stdin. Never a pty, never a session.
#[tauri::command]
pub async fn claude_oneshot(
    app: tauri::AppHandle,
    system_prompt: String,
    json_schema: String,
    prompt: String,
    timeout_ms: u64,
) -> Result<OneshotResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home folder: {e}"))?;
    let dir = home.join(".albedo").join("guide");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let timeout = Duration::from_millis(timeout_ms.clamp(1_000, MAX_TIMEOUT_MS));
    tauri::async_runtime::spawn_blocking(move || {
        run(dir, &system_prompt, &json_schema, prompt, timeout)
    })
    .await
    .map_err(|e| format!("one-shot run failed: {e}"))?
}

fn run(
    dir: PathBuf,
    system_prompt: &str,
    json_schema: &str,
    prompt: String,
    timeout: Duration,
) -> Result<OneshotResult, String> {
    let shell = login_shell();
    let opts = SpawnOptions {
        cwd: dir.to_string_lossy().into_owned(),
        command: "claude".to_string(),
        args: claude_args(system_prompt, json_schema),
        cols: 80,
        rows: 24,
        env: None,
    };
    let mut cmd = Command::new(&shell);
    cmd.arg("-l")
        .arg("-i")
        .arg("-c")
        .arg(shell_script(&shell, &opts))
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Layer 1 of the strip (layer 2 is the `unset` in the script).
    for key in STRIPPED_ENV {
        cmd.env_remove(key);
    }
    // Its own process group, so a timeout ends Claude Code and anything it
    // started, not only the first process.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {shell}: {e}"))?;
    let pid = child.id();

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let writer = thread::spawn(move || {
        // A child that exits early closes the pipe; that is its answer, not ours.
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let out_reader = thread::spawn(move || read_capped(stdout));
    let err_reader = thread::spawn(move || read_capped(stderr));

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => return Err(format!("waiting on claude failed: {e}")),
        }
        if Instant::now() >= deadline {
            timed_out = true;
            kill_group(pid);
            let _ = child.kill();
            break child.wait().ok();
        }
        thread::sleep(Duration::from_millis(100));
    };

    let _ = writer.join();
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(OneshotResult {
        code: if timed_out {
            None
        } else {
            status.and_then(|s| s.code())
        },
        stdout,
        stderr,
        timed_out,
    })
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    if let Ok(pgid) = i32::try_from(pid) {
        // SAFETY: plain syscall on a group we created; no memory involved.
        unsafe { libc::killpg(pgid, libc::SIGKILL) };
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

fn read_capped(mut r: impl Read) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if buf.len() < MAX_OUTPUT_BYTES {
                    let take = n.min(MAX_OUTPUT_BYTES - buf.len());
                    buf.extend_from_slice(&chunk[..take]);
                }
                // Keep draining past the cap, or the child blocks on a full pipe.
            }
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_run_is_fixed_no_tools_haiku_json_nothing_persisted() {
        let args = claude_args("sys", "{}");
        let joined = args.join(" ");
        assert_eq!(args[0], "-p");
        assert!(joined.contains("--model haiku"));
        assert!(joined.contains("--output-format json"));
        let tools = args.iter().position(|a| a == "--tools").expect("--tools");
        assert_eq!(args[tools + 1], "", "tools must be the empty list");
        for flag in [
            "--no-session-persistence",
            "--strict-mcp-config",
            "--disable-slash-commands",
        ] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}");
        }
        assert!(!args.iter().any(|a| a == "--mcp-config"));
        assert!(!args.iter().any(|a| a.contains("dangerously")));
    }

    #[test]
    fn the_script_unsets_the_anthropic_variables_before_claude() {
        let opts = SpawnOptions {
            cwd: "/tmp/g".into(),
            command: "claude".into(),
            args: claude_args("it's", "{}"),
            cols: 80,
            rows: 24,
            env: None,
        };
        let script = shell_script("/bin/zsh", &opts);
        let unset = script.find("unset ANTHROPIC_API_KEY").expect("unset");
        let exec = script.find("exec 'claude'").expect("exec");
        assert!(unset < exec);
        assert!(
            script.contains(r#"'it'\''s'"#),
            "the prompt words are quoted: {script}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn kill_group_ends_a_child_in_its_own_group_at_once() {
        // Not claude: `sleep` stands in for a run that never answers, killed
        // the way `run` kills one at its deadline.
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg("sleep 30")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
        let mut child = cmd.spawn().unwrap();
        let started = Instant::now();
        kill_group(child.id());
        let status = child.wait().unwrap();
        assert!(status.code().is_none(), "killed, not exited");
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
