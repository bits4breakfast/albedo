//! One-shot `claude -p` for the Review Guide (#186), and nothing else: the
//! guide's own run, and its Context step (#444, below).
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
//! ## The Context step (#444), a second, separately fixed run
//!
//! By the owner's decision (2026-11-18, issue #444), the Review Guide may run
//! one more one-shot before it is written: the user's own instructions, per
//! project, to pull background (a ticket, the support conversations behind
//! it) from their own MCP tools. `claude_context_oneshot` is that run, and
//! the widening is exactly this: it loads the user's MCP servers; it may call
//! only the tools the user listed (`--allowedTools`, each name checked here
//! against `^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_-]+)?$`, so no built-in can be
//! named); built-in tools stay off (`--tools ""`); the model is one of
//! haiku, sonnet, opus; the time limit is 5 minutes at most; it runs in
//! `~/.albedo/guide`, persists no session, has hooks disabled, and never
//! touches a task's session. The page chooses only the model, the tool
//! names, the time limit and the words. `claude_args` above is untouched by
//! it: the guide's own run is still no tools, Haiku, `--strict-mcp-config`.
//!
//! Measured on Claude Code 2.1.327, with a read-only tool of a claude.ai
//! connector and of a server in `~/.claude.json`:
//!
//! - Without `--strict-mcp-config`, `-p` loads the user's servers, claude.ai
//!   connectors included (27 servers, 308 tools here) -- but only with the
//!   `user` setting source: `--setting-sources ""` or `project` loads none.
//!   So the run has `--setting-sources user` (no project or local settings).
//! - `--tools ""` removes the built-ins only; every MCP tool stays. `--tools`
//!   with an MCP name changes nothing.
//! - `--allowedTools` only spares a tool the prompt. With `--permission-mode
//!   dontAsk` a tool not allowed is denied at once, no prompt (reported in
//!   `permission_denials`) -- unless a standing allow rule in the user's own
//!   settings names it: then it ran (verified with a rule passed through
//!   `--settings`). And all 308 definitions are sent on every request: a
//!   one-line answer cost ~400k input tokens and $0.40 on Haiku.
//! - So the run first LISTS: the same flags with `--output-format
//!   stream-json --verbose`, read up to its first line (`system`/`init`,
//!   ~2.5 s, which names every tool and every server with its status), then
//!   stopped. Everything not listed by the user goes into `--disallowedTools`
//!   (`deny_list`): each other tool, each server none of whose tools were
//!   listed, and each server not yet connected. A denied tool is gone from
//!   the run altogether ("isn't available in this session"), a standing allow
//!   rule no longer reaches it (verified), and its definition is not sent.
//!   A server name (`mcp__support`) in `--allowedTools` allows all of its
//!   tools (verified).
//! - `--json-schema` still works alongside MCP calls: `structured_output` is
//!   filled after the tool calls (its `StructuredOutput` tool is the one
//!   non-MCP tool in the listing, and is never denied).
//! - Cost and time, listing included, one tool call: Haiku ~$0.002 and
//!   ~12 s, Sonnet ~$0.04 and ~10 s; a tool's own answer can add ~40k
//!   tokens a request (one tracker listing did).
//! - Residual, recorded: a tool a connected server adds after the listing,
//!   on a server the user listed some tools of, is not in the deny list;
//!   `dontAsk` still denies it unless the user's own settings allow it.
//!
//! It goes through the user's login shell, exactly as `pty.rs` does, for the
//! same two reasons: a Finder-launched app's PATH does not reach `claude`, and
//! the `unset` of the Anthropic variables must run after the profile (hard
//! rule 3). The prompt goes in on stdin, so no argv limit applies to it.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Manager;

use crate::pty::{login_shell, login_shell_invocation, strip_env, SpawnOptions};

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
    let args = claude_args(&system_prompt, &json_schema);
    tauri::async_runtime::spawn_blocking(move || run(dir, args, prompt, Instant::now() + timeout))
        .await
        .map_err(|e| format!("one-shot run failed: {e}"))?
}

// ---------------------------------------------------------------------------
// The Context step (#444): a second, separately fixed run
// ---------------------------------------------------------------------------

/// The models the Context step may run on: Claude Code's aliases, nothing else.
pub(crate) const CONTEXT_MODELS: [&str; 3] = ["haiku", "sonnet", "opus"];
/// The longest the Context step may take, listing the tools included.
pub(crate) const CONTEXT_MAX_TIMEOUT_MS: u64 = 5 * 60 * 1000;
/// More tool names than this is not a list someone typed.
pub(crate) const CONTEXT_MAX_TOOLS: usize = 32;
/// Claude Code's own tool for `--json-schema`: the only tool that is not MCP.
const STRUCTURED_OUTPUT_TOOL: &str = "StructuredOutput";

/// `^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_-]+)?$`: an MCP server (`mcp__tracker`)
/// or one of its tools (`mcp__tracker__get_issue`). Nothing else -- so no
/// built-in (`Bash`, `Read`, `WebFetch`, `Write`), no rule with a pattern in
/// parentheses, no space or comma that would split into a second entry.
pub(crate) fn valid_tool_name(name: &str) -> bool {
    match name.strip_prefix("mcp__") {
        Some(rest) => {
            !rest.is_empty()
                && rest
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        }
        None => false,
    }
}

/// The checks on what the page may choose; the timeout to use when they pass.
pub(crate) fn check_context_request(
    model: &str,
    tools: &[String],
    timeout_ms: u64,
) -> Result<Duration, String> {
    if !CONTEXT_MODELS.contains(&model) {
        return Err(format!("model {model:?} is not one of haiku, sonnet, opus"));
    }
    if tools.is_empty() {
        return Err("no tools listed".into());
    }
    if tools.len() > CONTEXT_MAX_TOOLS {
        return Err(format!("more than {CONTEXT_MAX_TOOLS} tools listed"));
    }
    if let Some(bad) = tools.iter().find(|t| !valid_tool_name(t)) {
        return Err(format!("{bad:?} is not an MCP tool or server name"));
    }
    if timeout_ms > CONTEXT_MAX_TIMEOUT_MS {
        return Err("the time limit is over 5 minutes".into());
    }
    Ok(Duration::from_millis(timeout_ms.max(1_000)))
}

/// The flags every Context run has, the listing included: the user's MCP
/// servers (no `--strict-mcp-config`), no built-in tools, only the user's
/// settings file, nothing asked (anything not allowed is denied), no session,
/// no hooks, no slash commands.
fn context_base(model: &str) -> Vec<String> {
    [
        "-p",
        "--model",
        model,
        "--tools",
        "",
        "--setting-sources",
        "user",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--settings",
        r#"{"disableAllHooks":true}"#,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// The fixed argv of the Context run. The page supplies the model (from
/// [`CONTEXT_MODELS`]), the tool names (checked by [`valid_tool_name`]) and
/// the words; `denied` is Albedo's own, from [`deny_list`].
pub(crate) fn context_args(
    model: &str,
    allowed: &[String],
    denied: &[String],
    system_prompt: &str,
    json_schema: &str,
) -> Vec<String> {
    let mut args = context_base(model);
    args.extend(["--output-format".into(), "json".into()]);
    args.extend(["--allowedTools".into(), allowed.join(",")]);
    if !denied.is_empty() {
        args.extend(["--disallowedTools".into(), denied.join(",")]);
    }
    args.extend([
        "--system-prompt".into(),
        system_prompt.to_string(),
        "--json-schema".into(),
        json_schema.to_string(),
    ]);
    args
}

/// The listing: the same run, stopped at its first line (`system`/`init`),
/// which names every tool and server it loaded. On Haiku, whatever the
/// Context step's model, so a request that slips out before the stop is the
/// cheapest one.
fn listing_args() -> Vec<String> {
    let mut args = context_base("haiku");
    args.extend(
        [
            "--output-format",
            "stream-json",
            "--verbose",
            "--max-turns",
            "1",
            "--system-prompt",
            "Reply with one word.",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    args
}

/// What the listing found: every tool, and every server with its status.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Listing {
    pub tools: Vec<String>,
    pub servers: Vec<(String, String)>,
}

/// The `system`/`init` line, if this is it.
pub(crate) fn parse_init(line: &str) -> Option<Listing> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type")?.as_str()? != "system" || v.get("subtype")?.as_str()? != "init" {
        return None;
    }
    let tools = v
        .get("tools")?
        .as_array()?
        .iter()
        .filter_map(|t| t.as_str().map(str::to_string))
        .collect();
    let servers = v
        .get("mcp_servers")
        .and_then(|s| s.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|s| {
                    Some((
                        s.get("name")?.as_str()?.to_string(),
                        s.get("status")?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Listing { tools, servers })
}

/// A server's tool prefix, as Claude Code names them: `claude.ai Tracker`
/// -> `mcp__claude_ai_Tracker`.
pub(crate) fn server_prefix(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("mcp__{safe}")
}

fn under(name: &str, prefix: &str) -> bool {
    name == prefix
        || name
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with("__"))
}

/// Everything the run must not see: every tool the listing found that the
/// user did not list, every server none of whose tools they listed, and every
/// server not connected yet (its tools are unknown, so it is shut out whole).
/// `--allowedTools` only spares a tool a prompt; denying the rest takes them
/// out of the run altogether, so a standing allow rule in the user's own
/// settings cannot reach them, and their definitions are not sent (300 tools
/// cost ~200k input tokens a request, measured). Errs on a tool whose name
/// could not be denied exactly.
pub(crate) fn deny_list(allowed: &[String], listing: &Listing) -> Result<Vec<String>, String> {
    let covered = |tool: &str| allowed.iter().any(|a| under(tool, a));
    let mut out: Vec<String> = Vec::new();
    for tool in &listing.tools {
        if tool == STRUCTURED_OUTPUT_TOOL || covered(tool) {
            continue;
        }
        if !tool
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!("a tool named {tool:?} cannot be shut out"));
        }
        out.push(tool.clone());
    }
    for (name, status) in &listing.servers {
        let prefix = server_prefix(name);
        let wanted = allowed.iter().any(|a| under(a, &prefix));
        if status != "connected" || !wanted {
            out.push(prefix);
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// Run the Context step once (#444): list what the user's MCP servers offer,
/// then run with only the listed tools. Never a pty, never a session.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn claude_context_oneshot(
    app: tauri::AppHandle,
    model: String,
    tools: Vec<String>,
    system_prompt: String,
    json_schema: String,
    prompt: String,
    timeout_ms: u64,
) -> Result<OneshotResult, String> {
    let timeout = check_context_request(&model, &tools, timeout_ms)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home folder: {e}"))?;
    let dir = home.join(".albedo").join("guide");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let deadline = Instant::now() + timeout;
    tauri::async_runtime::spawn_blocking(move || {
        let listing = match list_tools(&dir, deadline)? {
            Listed::Found(l) => l,
            Listed::Ended(out) => return Ok(out),
            Listed::TimedOut => {
                return Ok(OneshotResult {
                    code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out: true,
                })
            }
        };
        let denied = deny_list(&tools, &listing)?;
        let args = context_args(&model, &tools, &denied, &system_prompt, &json_schema);
        run(dir, args, prompt, deadline)
    })
    .await
    .map_err(|e| format!("one-shot run failed: {e}"))?
}

/// How the listing went.
enum Listed {
    Found(Listing),
    /// The deadline came first.
    TimedOut,
    /// It ended without an `init` line (`claude` missing, not signed in, ...):
    /// its output, for the page to read as it reads any failed run.
    Ended(OneshotResult),
}

/// The listing's `init` line, read and then the run stopped at once.
fn list_tools(dir: &Path, deadline: Instant) -> Result<Listed, String> {
    use std::io::BufRead;
    use std::sync::mpsc;
    let shell = login_shell();
    let mut cmd = build_command(&shell, dir, listing_args());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {shell}: {e}"))?;
    let pid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        // Dropped here, so the prompt ends.
        let _ = stdin.write_all(b".");
    }
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let err_reader = thread::spawn(move || read_capped(stderr));
    let (tx, rx) = mpsc::channel::<Listing>();
    let reader = thread::spawn(move || {
        let mut seen = String::new();
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(found) = parse_init(&line) {
                let _ = tx.send(found);
                return seen;
            }
            if seen.len() < MAX_OUTPUT_BYTES {
                seen.push_str(&line);
                seen.push('\n');
            }
        }
        seen
    });
    let found = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break Err(true);
        }
        match rx.recv_timeout(left.min(Duration::from_millis(200))) {
            Ok(l) => break Ok(l),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break Err(false),
        }
    };
    let mut exited = None;
    if matches!(found, Err(false)) {
        // Its output closed: it is ending. A moment for its exit code.
        let until = Instant::now() + Duration::from_secs(2);
        while exited.is_none() && Instant::now() < until {
            match child.try_wait() {
                Ok(Some(status)) => exited = Some(status),
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
    }
    // Found, out of time, or slow to end: the listing is all it was for. Never
    // a group already reaped, whose id may belong to someone else by now.
    let status = match exited {
        Some(status) => Some(status),
        None => {
            kill_group(pid);
            let _ = child.kill();
            child.wait().ok()
        }
    };
    let stdout = reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(match found {
        Ok(l) => Listed::Found(l),
        Err(true) => Listed::TimedOut,
        Err(false) => Listed::Ended(OneshotResult {
            code: status.and_then(|s| s.code()),
            stdout,
            stderr,
            timed_out: false,
        }),
    })
}

fn run(
    dir: PathBuf,
    args: Vec<String>,
    prompt: String,
    deadline: Instant,
) -> Result<OneshotResult, String> {
    let shell = login_shell();
    let mut cmd = build_command(&shell, &dir, args);
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

/// The login shell running `claude` with the fixed argv, in `dir`, with the
/// Anthropic variables stripped -- the same invocation and strip as the ptys.
fn build_command(shell: &str, dir: &Path, args: Vec<String>) -> Command {
    let opts = SpawnOptions {
        cwd: dir.to_string_lossy().into_owned(),
        command: "claude".to_string(),
        args,
        cols: 80,
        rows: 24,
        env: None,
    };
    let mut cmd = Command::new(shell);
    cmd.args(login_shell_invocation(shell, &opts))
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Layer 1 of the strip (layer 2 is the `unset` in the script).
    strip_env(|key| {
        cmd.env_remove(key);
    });
    // Its own process group, so a timeout ends Claude Code and anything it
    // started, not only the first process.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
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
    use crate::pty::shell_script;

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
    fn the_guide_run_is_unchanged_byte_for_byte() {
        // #444 added a second mode; the guide's own argv must not move.
        let expected: Vec<String> = [
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
            "sys",
            "--json-schema",
            "{}",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(claude_args("sys", "{}"), expected);
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_context_run_is_fixed_listed_mcp_tools_only_nothing_persisted() {
        let allowed = names(&["mcp__tracker__get_issue", "mcp__support"]);
        let denied = names(&["mcp__tracker__save_issue", "mcp__mail"]);
        let args = context_args("sonnet", &allowed, &denied, "sys", "{}");
        let joined = args.join(" ");
        assert_eq!(args[0], "-p");
        assert!(joined.contains("--model sonnet"));
        assert!(joined.contains("--output-format json"));
        let at = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .unwrap_or_else(|| panic!("{flag}"))
        };
        assert_eq!(args[at("--tools") + 1], "", "no built-in tools");
        assert_eq!(args[at("--setting-sources") + 1], "user");
        assert_eq!(args[at("--permission-mode") + 1], "dontAsk");
        assert_eq!(
            args[at("--allowedTools") + 1],
            "mcp__tracker__get_issue,mcp__support"
        );
        assert_eq!(
            args[at("--disallowedTools") + 1],
            "mcp__tracker__save_issue,mcp__mail"
        );
        assert_eq!(args[at("--settings") + 1], r#"{"disableAllHooks":true}"#);
        for flag in ["--no-session-persistence", "--disable-slash-commands"] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}");
        }
        // The user's servers load: neither of these, ever.
        assert!(!args.iter().any(|a| a == "--strict-mcp-config"));
        assert!(!args.iter().any(|a| a == "--mcp-config"));
        assert!(!args.iter().any(|a| a.contains("dangerously")));
        assert!(!args.iter().any(|a| a == "bypassPermissions"));
        // Nothing denied: no empty flag.
        let none = context_args("haiku", &allowed, &[], "sys", "{}");
        assert!(!none.iter().any(|a| a == "--disallowedTools"));
    }

    #[test]
    fn the_listing_is_the_same_run_on_haiku_stopped_at_its_first_line() {
        let args = listing_args();
        let joined = args.join(" ");
        assert!(joined.contains("--model haiku"));
        assert!(joined.contains("--output-format stream-json --verbose"));
        assert!(joined.contains("--setting-sources user --permission-mode dontAsk"));
        let tools = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[tools + 1], "");
        assert!(!args.iter().any(|a| a == "--allowedTools"));
        assert!(!args.iter().any(|a| a == "--strict-mcp-config"));
    }

    #[test]
    fn only_mcp_names_pass() {
        for ok in [
            "mcp__tracker",
            "mcp__tracker__get_issue",
            "mcp__claude_ai_Tracker__list_teams",
            "mcp__shop-api__find",
        ] {
            assert!(valid_tool_name(ok), "{ok}");
        }
        for bad in [
            "Bash",
            "Read",
            "WebFetch",
            "Write",
            "Edit",
            "Bash(git *)",
            "mcp__",
            "mcp_tracker",
            "MCP__tracker",
            "mcp__tracker__get issue",
            "mcp__tracker,Bash",
            "mcp__tracker Bash",
            "mcp__tracker(*)",
            "mcp__tracker__*",
            " mcp__tracker",
            "",
        ] {
            assert!(!valid_tool_name(bad), "{bad:?} passed");
        }
    }

    #[test]
    fn the_request_is_checked_model_tools_and_time() {
        let tools = names(&["mcp__tracker__get_issue"]);
        assert!(check_context_request("sonnet", &tools, 120_000).is_ok());
        assert!(check_context_request("haiku", &tools, 300_000).is_ok());
        assert!(check_context_request("opus", &tools, 1).is_ok());
        assert!(check_context_request("fable", &tools, 120_000).is_err());
        assert!(check_context_request("claude-sonnet-4-5", &tools, 120_000).is_err());
        assert!(check_context_request("sonnet", &tools, 300_001).is_err());
        assert!(check_context_request("sonnet", &[], 120_000).is_err());
        assert!(check_context_request("sonnet", &names(&["Bash"]), 120_000).is_err());
        assert!(check_context_request(
            "sonnet",
            &names(&["mcp__tracker__get_issue", "WebFetch"]),
            120_000
        )
        .is_err());
        let many: Vec<String> = (0..=CONTEXT_MAX_TOOLS)
            .map(|i| format!("mcp__s__t{i}"))
            .collect();
        assert!(check_context_request("sonnet", &many, 120_000).is_err());
    }

    #[test]
    fn the_init_line_is_read_and_nothing_else() {
        let line = r#"{"type":"system","subtype":"init","tools":["mcp__tracker__get_issue","StructuredOutput"],"mcp_servers":[{"name":"claude.ai Tracker","status":"connected"},{"name":"mail","status":"needs-auth"}]}"#;
        let got = parse_init(line).expect("init");
        assert_eq!(
            got.tools,
            names(&["mcp__tracker__get_issue", "StructuredOutput"])
        );
        assert_eq!(
            got.servers,
            vec![
                ("claude.ai Tracker".to_string(), "connected".to_string()),
                ("mail".to_string(), "needs-auth".to_string())
            ]
        );
        assert!(parse_init(r#"{"type":"assistant"}"#).is_none());
        assert!(parse_init("Last login: today").is_none());
    }

    #[test]
    fn server_prefixes_follow_claude_codes_names() {
        assert_eq!(server_prefix("claude.ai Tracker"), "mcp__claude_ai_Tracker");
        assert_eq!(server_prefix("plugin:shop:api"), "mcp__plugin_shop_api");
        assert_eq!(server_prefix("support-desk"), "mcp__support-desk");
    }

    #[test]
    fn everything_not_listed_is_shut_out() {
        let listing = Listing {
            tools: names(&[
                "mcp__tracker__get_issue",
                "mcp__tracker__save_issue",
                "mcp__support__search",
                "mcp__support__reply",
                "mcp__mail__send",
                "StructuredOutput",
            ]),
            servers: vec![
                ("tracker".into(), "connected".into()),
                ("support".into(), "connected".into()),
                ("mail".into(), "connected".into()),
                ("calendar".into(), "needs-auth".into()),
                ("docs".into(), "pending".into()),
            ],
        };
        let allowed = names(&["mcp__tracker__get_issue", "mcp__support", "mcp__docs__read"]);
        let denied = deny_list(&allowed, &listing).unwrap();
        assert_eq!(
            denied,
            names(&[
                "mcp__calendar",
                // Listed, but not connected when listed: its tools are
                // unknown, so all of it is shut out.
                "mcp__docs",
                "mcp__mail",
                "mcp__mail__send",
                "mcp__tracker__save_issue",
            ])
        );
        // A server listed whole keeps all its tools; nothing built in survives.
        assert!(!denied.iter().any(|d| d.starts_with("mcp__support")));
        let odd = Listing {
            tools: names(&["Bash"]),
            servers: vec![],
        };
        assert_eq!(deny_list(&allowed, &odd).unwrap(), names(&["Bash"]));
        let unsafe_name = Listing {
            tools: names(&["mcp__x__a,b"]),
            servers: vec![],
        };
        assert!(deny_list(&allowed, &unsafe_name).is_err());
    }

    /// The measurement in the module doc, against the real `claude`:
    /// `ALBEDO_MEASURE_TOOL=mcp__<server>__<a read-only tool> cargo test
    /// measure_the_context_run -- --ignored --nocapture`. Prints the listing's
    /// size, the deny list's, and the result's cost, turns and denials --
    /// never what the tool returned.
    #[test]
    #[ignore]
    fn measure_the_context_run() {
        let tool = std::env::var("ALBEDO_MEASURE_TOOL").expect("ALBEDO_MEASURE_TOOL");
        let model = std::env::var("ALBEDO_MEASURE_MODEL").unwrap_or_else(|_| "haiku".into());
        let dir = std::env::temp_dir().join("albedo-measure-context");
        std::fs::create_dir_all(&dir).unwrap();
        let deadline = Instant::now() + Duration::from_secs(300);
        let started = Instant::now();
        let Listed::Found(listing) = list_tools(&dir, deadline).unwrap() else {
            panic!("no listing")
        };
        println!(
            "listing: {} tools, {} servers, {:?}",
            listing.tools.len(),
            listing.servers.len(),
            started.elapsed()
        );
        let allowed = vec![tool.clone()];
        let denied = deny_list(&allowed, &listing).unwrap();
        println!("denied: {} entries", denied.len());
        let schema = r#"{"type":"object","properties":{"calls":{"type":"array","items":{"type":"object","properties":{"tool":{"type":"string"},"outcome":{"type":"string","enum":["ok","denied","missing"]}},"required":["tool","outcome"]}}},"required":["calls"]}"#;
        let prompt = format!(
            "Call {tool} once. Then try to call any other tool you have, and Bash. Report each call's outcome only: no data."
        );
        let args = context_args(
            &model,
            &allowed,
            &denied,
            "You test which tools you may call.",
            schema,
        );
        let out = run(dir, args, prompt, deadline).unwrap();
        let line = out
            .stdout
            .lines()
            .rev()
            .find(|l| l.starts_with('{'))
            .unwrap_or("{}");
        let v: serde_json::Value = serde_json::from_str(line).unwrap_or_default();
        println!(
            "code {:?} total {:?} turns {} cost {} denials {} structured {}",
            out.code,
            started.elapsed(),
            v["num_turns"],
            v["total_cost_usd"],
            v["permission_denials"],
            v["structured_output"]
        );
    }

    #[test]
    fn the_command_is_the_login_shell_with_the_anthropic_variables_removed() {
        let cmd = build_command("/bin/zsh", Path::new("/tmp/g"), claude_args("sys", "{}"));
        assert_eq!(cmd.get_program(), "/bin/zsh");
        let args: Vec<_> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&args[..3], ["-l", "-i", "-c"]);
        assert_eq!(args.len(), 4);
        assert!(
            args[3].starts_with("cd '/tmp/g' || exit 1; unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL; exec 'claude' '-p'"),
            "{}",
            args[3]
        );
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/tmp/g")));
        let removed: Vec<_> = cmd
            .get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        for key in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
        ] {
            assert!(removed.iter().any(|k| k == key), "{key} not removed");
        }
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
